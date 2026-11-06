// 极简日志。归属：lead（冻结契约文件）
export function log(scope, ...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} [${scope}]`, ...args);
}

export function makeLogger(scope) {
  return {
    info: (...a) => log(scope, ...a),
    warn: (...a) => console.warn(new Date().toISOString().slice(11, 19), `[${scope}]`, ...a),
    error: (...a) => console.error(new Date().toISOString().slice(11, 19), `[${scope}]`, ...a),
  };
}
