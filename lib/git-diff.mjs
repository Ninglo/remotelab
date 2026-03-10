import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';

function parseUnifiedDiff(rawDiff) {
  if (!rawDiff || rawDiff.trim() === '') {
    return { stats: { files: 0, additions: 0, deletions: 0 }, files: [] };
  }

  const files = [];
  const fileSections = rawDiff.split(/^diff --git /m).filter(s => s.trim());

  for (const section of fileSections) {
    const lines = section.split('\n');

    let oldPath = null;
    let newPath = null;
    let status = 'modified';
    let isBinary = false;

    for (let i = 0; i < lines.length && i < 10; i++) {
      const line = lines[i];
      if (line.startsWith('--- a/')) {
        oldPath = line.substring(6);
      } else if (line.startsWith('+++ b/')) {
        newPath = line.substring(6);
      } else if (line.startsWith('--- /dev/null')) {
        oldPath = '/dev/null';
        status = 'new';
      } else if (line.startsWith('+++ /dev/null')) {
        newPath = '/dev/null';
        status = 'deleted';
      } else if (line.includes('Binary files')) {
        isBinary = true;
      } else if (line.startsWith('rename from')) {
        status = 'renamed';
      }
    }

    const filePath = newPath && newPath !== '/dev/null' ? newPath : oldPath;
    if (!filePath) continue;

    const hunks = [];
    let currentHunk = null;
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)/);
        if (match) {
          currentHunk = {
            oldStart: parseInt(match[1], 10),
            oldCount: match[2] ? parseInt(match[2], 10) : 1,
            newStart: parseInt(match[3], 10),
            newCount: match[4] ? parseInt(match[4], 10) : 1,
            header: match[5].trim(),
            lines: []
          };
        }
      } else if (currentHunk && !line.startsWith('\\')) {
        let type = 'context';
        let content = line;

        if (line.startsWith('+')) {
          type = 'addition';
          content = line.substring(1);
          additions++;
        } else if (line.startsWith('-')) {
          type = 'deletion';
          content = line.substring(1);
          deletions++;
        } else if (line.startsWith(' ')) {
          content = line.substring(1);
        }

        currentHunk.lines.push({ type, content });
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    files.push({
      path: filePath,
      oldPath: oldPath !== '/dev/null' ? oldPath : null,
      newPath: newPath !== '/dev/null' ? newPath : null,
      status,
      isBinary,
      additions,
      deletions,
      hunks
    });
  }

  const stats = {
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0)
  };

  return { stats, files };
}

export function getGitDiff(folder) {
  try {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      return { isGitRepo: false, error: 'Folder does not exist' };
    }

    let rawDiff;
    try {
      rawDiff = execSync('git diff HEAD', {
        cwd: folder,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 10000,
        encoding: 'utf8'
      });
    } catch (err) {
      if (err.message.includes('unknown revision')) {
        try {
          rawDiff = execSync('git diff --cached', {
            cwd: folder,
            maxBuffer: 5 * 1024 * 1024,
            timeout: 10000,
            encoding: 'utf8'
          });
        } catch (stagingErr) {
          if (stagingErr.message.includes('not a git repository')) {
            return { isGitRepo: false };
          }
          rawDiff = '';
        }
      } else if (err.message.includes('not a git repository')) {
        return { isGitRepo: false };
      } else {
        throw err;
      }
    }

    const parsed = parseUnifiedDiff(rawDiff);
    return { isGitRepo: true, ...parsed };
  } catch (err) {
    console.error('Git diff error:', err.message);
    return { isGitRepo: true, error: err.message, stats: { files: 0, additions: 0, deletions: 0 }, files: [] };
  }
}
