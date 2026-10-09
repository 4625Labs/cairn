// Serial access without native modules. Written for the real board; UNVERIFIED against hardware
// (this build was only exercised against a pty / fake). The hub never calls this when
// AGENT_DIAL_PORT is "none" or "sim".
import fs from "node:fs";
import { execFileSync, execFile } from "node:child_process";

export const VENDOR = 0x303a; // Espressif

export function candidatePorts() {
  try {
    return fs.readdirSync("/dev").filter((n) => /^(cu\.usbmodem|ttyACM)/.test(n)).map((n) => "/dev/" + n);
  } catch { return []; }
}

/** True when an Espressif (303a) USB device is attached. Cheap: ioreg on macOS, sysfs on Linux. */
export function boardPresent() {
  const mode = process.env.AGENT_DIAL_PORT;
  if (mode === "none" || mode === "sim") return false;
  if (mode) return fs.existsSync(mode);
  if (!candidatePorts().length) return false;
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-p", "IOUSB", "-l", "-w0"], { encoding: "utf8", timeout: 1500, maxBuffer: 8 << 20 });
      return out.includes(`"idVendor" = ${VENDOR}`);
    }
    return execFileSync("sh", ["-c", "cat /sys/bus/usb/devices/*/idVendor 2>/dev/null"], { encoding: "utf8", timeout: 1500 }).includes("303a");
  } catch { return false; }
}

/** Open a tty (or pty) raw. Returns {write(buf), close()}; callbacks fire on data and on close. */
export function openPort(path, { onData, onClose }) {
  const flag = process.platform === "darwin" ? "-f" : "-F";
  // -hupcl: do not drop DTR on close (a DTR/RTS pulse can reset an ESP32-S3).
  execFileSync("stty", [flag, path, "115200", "raw", "-echo", "-hupcl", "clocal"], { stdio: "ignore", timeout: 2000 });
  const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
  let closed = false;
  const rs = fs.createReadStream(null, { fd, autoClose: false });
  const done = () => { if (closed) return; closed = true; try { fs.closeSync(fd); } catch {} onClose?.(); };
  rs.on("data", (d) => { try { onData(d); } catch {} });
  rs.on("error", done);
  rs.on("end", done);
  return {
    write(buf) {
      if (closed) return false;
      try { fs.writeSync(fd, buf); return true; } catch (e) {
        if (e.code === "EAGAIN") return false; // never stall the hub on a stuffed cable
        done(); return false;
      }
    },
    close() { if (!closed) { closed = true; try { rs.destroy(); fs.closeSync(fd); } catch {} onClose?.(); } },
  };
}
export { execFile };
