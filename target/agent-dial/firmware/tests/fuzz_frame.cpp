// Random-byte fuzz of dial::Decoder under ASan/UBSan: must never crash, never accept a frame > cap.
#include "../agent_dial/dial_frame.h"
#include <cstdio>
#include <cstdlib>
static size_t maxSeen = 0, nframes = 0;
static void h(uint8_t, const uint8_t*, size_t n, void*) { nframes++; if (n > maxSeen) maxSeen = n; }
int main() {
  srand(12345);
  static dial::Decoder d(h, nullptr);
  static uint8_t buf[4096];
  for (int round = 0; round < 20000; round++) {
    size_t n = rand() % sizeof buf;
    for (size_t i = 0; i < n; i++) {
      int r = rand() % 8;
      buf[i] = r == 0 ? 0xA5 : r == 1 ? 0x45 : r == 2 ? 0xFF : (uint8_t)rand();
    }
    if (round % 3 == 0 && n > 20) {  // splice in a valid-looking frame with random len
      size_t len = rand() % 3000; if (len + 8 > n) len = n - 8;
      uint8_t* f = buf + (rand() % (n - len - 8 + 1));
      f[0] = 0xA5; f[1] = 0x45; f[2] = 1; f[3] = 1; f[4] = len & 255; f[5] = len >> 8;
      uint16_t c = dial::crc16(f + 2, 4 + len); f[6 + len] = c & 255; f[7 + len] = c >> 8;
    }
    size_t off = 0;
    while (off < n) { size_t k = 1 + rand() % 300; if (off + k > n) k = n - off; d.feed(buf + off, k); off += k; }
  }
  printf("fuzz ok: frames=%zu max_payload_seen=%zu cap=%zu discarded=%u\n", nframes, maxSeen, dial::kMaxPayload, d.discarded());
  return maxSeen <= dial::kMaxPayload ? 0 : 1;
}
