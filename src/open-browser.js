import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

// Open the control panel with no visible console window. Prefers Edge's
// "app mode" (a chromeless window that feels like a native app); otherwise
// falls back to the default browser. windowsHide keeps the launcher process
// from flashing a console.
export function openBrowser(url) {
  const edges = [
    process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter(Boolean);
  const edge = edges.find((p) => existsSync(p));
  try {
    const child = edge
      ? spawn(edge, [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best effort — the URL is printed in the console too
  }
}
