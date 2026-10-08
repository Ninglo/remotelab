import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../static/chat/inline-flow.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const parse = value => {
  const result = context.RemoteLabInlineFlow.parse(value);
  return result === null ? null : JSON.parse(JSON.stringify(result));
};

// A branching graph with a shared endpoint: neither condition may disappear.
const flow = parse(`flowchart TD
  A[Receive] --> B[Handle]
  B --> C{Check context}
  C --> D[Continue work]
  C --> E[Prepare reply]
  C --> F{Related discussion?}
  F -->|No relation| G[Continue here]
  F -->|Related| H{Review scope}
  H -->|Proceed| I[Share context]
  H -->|Defer| G
  I --> J[Reassess]
  J --> K[Record result]
  K --> L[Return result]`);
assert.equal(flow.nodes.length, 12);
assert.equal(flow.edges.length, 12);
assert.equal(flow.nodes.find(node => node.id === 'F').kind, 'decision');
assert.deepEqual(flow.edges.filter(edge => edge.target === 'G').map(edge => edge.label), ['No relation', 'Defer']);
assert.deepEqual(flow.edges.filter(edge => edge.label).map(edge => edge.label), ['No relation', 'Related', 'Proceed', 'Defer']);

assert.deepEqual(parse('graph LR; A[Start]-->B[Next]-->C[End]').edges, [
  { source: 'A', target: 'B', label: '' }, { source: 'B', target: 'C', label: '' },
]);
assert.equal(parse('flowchart TD\nA-->B[Named later]').nodes[1].label, 'Named later');
assert.equal(parse('flowchart TD\nA[First]\nB(Second)\nA-->B').nodes[1].label, 'Second');
assert.equal(parse('flowchart TD\n%% comment\nA["A; B [C]"]-->B["two<br/>lines"]').nodes[0].label, 'A; B [C]');
assert.equal(parse('flowchart TD\nA["two<br/>lines"]').nodes[0].label, 'two\nlines');
assert.equal(parse("flowchart TD\nA[Don't discard apostrophes]").nodes[0].label, "Don't discard apostrophes");
assert.equal(parse('flowchart TD\njob-one((Start))-->job-two{Check}').nodes[0].label, 'Start');
assert.equal(parse('flowchart TD\nA-->B\nB-->A').edges.length, 2, 'cycles must retain their connections');
assert.equal(parse('flowchart TD\nA["<img src=x onerror=alert(1)>"]').nodes[0].label, '<img src=x onerror=alert(1)>', 'labels remain text, never executable markup');

for (const incomplete of ['flowchart TD', 'flowchart TD\nA[unfinished', 'flowchart TD\nA-->', 'flowchart TD\nA-->|unfinished B', 'flowchart TD\nA["unfinished]']) {
  assert.equal(parse(incomplete), null, `streaming fragments must remain ordinary code: ${incomplete}`);
}
for (const unsupported of [
  'const text = "flowchart TD";',
  'sequenceDiagram\nAlice->>Bob: Hello',
  'flowchart TD\nA-->B\nclick A "https://example.com"',
  'flowchart TD\nA-->B\nclassDef hidden display:none',
  'flowchart TD\nsubgraph internal\nA-->B\nend',
  'flowchart TD\nA[One]\nA[Conflicting]',
]) assert.equal(parse(unsupported), null, 'unsupported syntax must not produce a misleading partial view');
assert.equal(parse(`flowchart TD\nA[${'x'.repeat(30000)}]`), null, 'oversized input stays code');
assert.equal(parse(`flowchart TD\n${Array.from({length:65}, (_,index) => `N${index}[Step]`).join('\n')}`), null, 'bound DOM growth');

// The visible layout must preserve splits and joins, independent of declaration direction.
const layout = graph => JSON.parse(JSON.stringify(context.RemoteLabInlineFlow.layout(graph)));
const diagram = layout(flow);
const positions = new Map(diagram.nodes.map(node => [node.id, node]));
assert.equal(diagram.nodes.length, 12, 'a shared endpoint is drawn once');
assert.equal(diagram.edges.length, 12, 'every original connection is visible');
for (const edge of diagram.edges) {
  assert.ok(positions.get(edge.source).x < positions.get(edge.target).x, 'forward edges progress left to right');
  assert.ok(edge.path && !edge.path.includes('NaN'), 'connections have finite geometry');
  if (edge.label) assert.ok(Number.isFinite(edge.labelX) && Number.isFinite(edge.labelY));
}
assert.equal(positions.get('D').x, positions.get('E').x);
assert.equal(positions.get('E').x, positions.get('F').x);
assert.ok(positions.get('D').y < positions.get('E').y && positions.get('E').y < positions.get('F').y,
  'the three parallel branches occupy separate visible lanes');
assert.equal(diagram.edges.filter(edge => edge.target === 'G').length, 2, 'both routes enter the same merge');
for (const a of diagram.nodes) for (const b of diagram.nodes) {
  if (a.id === b.id) continue;
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
    'step cards cannot overlap');
}
for (const input of ['graph LR; A-->B; B-->A; C[Separate]', 'graph LR; A-->A',
  'graph LR; A-->B; A-->C; B-->D; C-->D; D-->B']) {
  const graph = parse(input), drawing = layout(graph);
  assert.equal(drawing.nodes.length, graph.nodes.length);
  assert.equal(drawing.edges.length, graph.edges.length);
  assert.ok(drawing.edges.some(edge => edge.returning), 'cycles keep an explicit return connector');
  assert.ok(Number.isFinite(drawing.width) && Number.isFinite(drawing.height));
  for (const node of drawing.nodes) assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.width <= drawing.width && node.y + node.height <= drawing.height);
}
const disconnected = layout(parse('graph BT; A[First]; B[Second]; C[Third]'));
assert.equal(new Set(disconnected.nodes.map(node => node.y)).size, 3, 'unconnected components remain visible');

console.log('test-chat-inline-flow: ok');
