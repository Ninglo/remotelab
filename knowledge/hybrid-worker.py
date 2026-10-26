"""Optional local-only retrieval worker; corpus files are validated by Node.

No generation/query rewriting. Models stay resident; changed corpus hashes
rebuild the index. Parent stdin EOF terminates this private socket worker.
"""
import json, os, re, socket, sys, threading, time
import numpy as np
import torch
import jieba
from sentence_transformers import SentenceTransformer, CrossEncoder
from rank_bm25 import BM25Okapi


def parent_closed():
    sys.stdin.buffer.read()
    os._exit(0)


threading.Thread(target=parent_closed, daemon=True).start()
config = json.loads(sys.argv[2])
torch.set_num_threads(config.get('cpuThreads', 8))
jieba.setLogLevel(40)
started = time.perf_counter()
encoder = SentenceTransformer(config['embeddingModelPath'], device='cpu', local_files_only=True)
reranker = CrossEncoder(config['rerankerModelPath'], device='cpu', max_length=512, local_files_only=True)
model_load_ms = (time.perf_counter() - started) * 1000
current_hash = None
chunks, texts, vectors, bm25 = [], [], None, None


def tokens(text):
    return [word.lower() for word in jieba.cut(text) if re.search(r'\w', word)]


def retrieve(request):
    global current_hash, chunks, texts, vectors, bm25
    started = time.perf_counter()
    rebuilt = request['corpusHash'] != current_hash
    if rebuilt:
        new_chunks = []
        for page in request['pages']:
            heading = page['title']
            for paragraph in re.split(r'\n\s*\n', page['text']):
                if paragraph.startswith('#'):
                    heading = paragraph.lstrip('# ').strip()
                    continue
                if paragraph.startswith('**适用：**') or not paragraph.strip():
                    continue
                new_chunks.append({'page': page['file'], 'section': heading,
                                   'title': page['title'], 'applies': page.get('whenToUse', ''),
                                   'text': paragraph})
        if not new_chunks:
            raise ValueError('Knowledge corpus has no evidence paragraphs')
        new_texts = [c['title'] + '\n' + c['section'] + '\n' + c['text'] for c in new_chunks]
        new_vectors = encoder.encode(['passage: '+t for t in new_texts], normalize_embeddings=True,
                                     show_progress_bar=False, batch_size=16)
        new_bm25 = BM25Okapi([tokens(t) for t in new_texts])
        chunks, texts, vectors, bm25 = new_chunks, new_texts, new_vectors, new_bm25
        current_hash = request['corpusHash']
    index_ms = (time.perf_counter() - started) * 1000 if rebuilt else 0
    query = request['query']
    qvec = encoder.encode(['query: '+query], normalize_embeddings=True, show_progress_bar=False)[0]
    dense = vectors @ qvec
    lexical = bm25.get_scores(tokens(query))
    scores = {}
    for order in [np.argsort(-dense), [i for i in np.argsort(-lexical) if lexical[i] > 0]]:
        for place, i in enumerate(order):
            scores[int(i)] = scores.get(int(i), 0) + 1 / (60 + place + 1)
    candidates = sorted(scores, key=lambda i: (-scores[i], i))[:config.get('candidateCount', 12)]
    rank_scores = reranker.predict([(query, texts[i]) for i in candidates], show_progress_bar=False,
                                   batch_size=config.get('candidateCount', 12))
    candidates = [i for _, i in sorted(zip(np.atleast_1d(rank_scores), candidates), key=lambda x: -x[0])]
    selected, used = [], 0
    for i in candidates:
        c = {k:chunks[i][k] for k in ['page','section','applies','text']}
        cost = len(json.dumps(c, ensure_ascii=False))
        if len(selected) == config.get('maxPassages', 3):
            break
        if used + cost <= config.get('maxEvidenceChars', 2200):
            selected.append(c)
            used += cost
    return {'passages': selected, 'metrics': {'modelLoadMs':model_load_ms, 'indexBuilt':rebuilt,
            'indexMs':index_ms, 'elapsedMs':(time.perf_counter()-started)*1000, 'chunks':len(chunks)}}


server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(sys.argv[1])
server.listen()
print(json.dumps({'ready':True, 'modelLoadMs':model_load_ms}), flush=True)
while True:
    connection, _ = server.accept()
    with connection:
        try:
            connection.settimeout(config.get('timeoutMs', 30000)/1000)
            data = bytearray()
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 16*1024*1024:
                    raise ValueError('Knowledge corpus exceeds worker request budget')
            result = retrieve(json.loads(data))
        except Exception as error:
            result = {'error':str(error)}
        try:
            connection.sendall(json.dumps(result, ensure_ascii=False).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass
