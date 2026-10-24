import { defineConfig, type Plugin } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

function autoStartBackendPlugin(): Plugin {
  let backendProc: ChildProcess | null = null;
  return {
    name: 'auto-start-fastapi-backend',
    configureServer(server) {
      void (async () => {
        if (await isPortOpen(8000)) {
          return;
        }
        const uvicornBin = path.join(repoRoot, 'backend', '.venv', 'bin', 'uvicorn');
        if (!existsSync(uvicornBin)) {
          console.warn(`[backend] ${uvicornBin} not found; skipping auto-start.`);
          return;
        }
        console.log('[backend] Starting FastAPI server on http://127.0.0.1:8000 ...');
        backendProc = spawn(
          uvicornBin,
          ['backend.main:app', '--host', '127.0.0.1', '--port', '8000'],
          {
            cwd: repoRoot,
            stdio: 'inherit',
          },
        );
        backendProc.on('exit', () => {
          backendProc = null;
        });
      })();

      server.httpServer?.once('close', () => {
        if (backendProc && !backendProc.killed) {
          backendProc.kill('SIGTERM');
          backendProc = null;
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [autoStartBackendPlugin()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // FastAPI backend: uvicorn backend.main:app --reload --port 8000
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  detail:
                    'Backend server is starting or not running on port 8000. Run `npm run backend` if needed.',
                }),
              );
            }
          });
        },
      },
    },
  },
});
