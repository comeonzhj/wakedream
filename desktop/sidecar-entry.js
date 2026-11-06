// 边车（sidecar）入口：给 esbuild 打包用的薄壳。
// 为什么需要它：src/server/main.js 用 `isMain`（比较 process.argv[1] 与 import.meta.url）判断
// 「是不是被直接执行」。SEA 二进制里 argv[1] 是可执行文件路径、import.meta.url 被 shim 成
// 可执行文件的 file URL，两者不相等，所以 main.js 自己不会启动；这里显式调用 start()。
//
// 归属：desktop worker。不要往这里塞业务逻辑——业务全在 src/**（各有归属）。
import { start } from '../src/server/main.js';

process.title = 'wakedream-server';

start()
    .then(({ server, port, host }) => {
        const shutdown = (signal) => {
            console.error(`[sidecar] 收到 ${signal}，关闭服务`);
            try {
                server.closeAllConnections?.();
                server.close();
            } catch { /* 已经在关 */ }
            process.exit(0);
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        // 父进程没了（桌面包崩溃）也别变孤儿：被 reparent 到 launchd/init 时自杀。
        // 正常退出路径由 Rust 侧显式 kill 负责，这里只是兜底。
        setInterval(() => {
            if (process.ppid === 1) shutdown('parent-exited');
        }, 5000).unref();
        console.error(`[sidecar] 就绪 http://${host}:${port} pid=${process.pid}`);
    })
    .catch((err) => {
        console.error('[sidecar] 启动失败：', err?.stack || err);
        process.exit(1);
    });
