const NUL_BYTE_RE = /\u0000/g;

export function sanitizeSpawnArg(value) {
  if (typeof value !== 'string') return value;
  return value.includes('\u0000') ? value.replace(NUL_BYTE_RE, '') : value;
}

export function sanitizeSpawnArgs(args) {
  return args.map((arg) => sanitizeSpawnArg(arg));
}
