// Host test for dial_frame.h against tests/vectors/dial_frame.txt plus strict-bound checks.
// Build: c++ -std=c++17 -Wall -Wextra -DDIAL_MAX_PAYLOAD=8192 test_frame.cpp -o /tmp/tf  (vector mode)
//        c++ -std=c++17 -Wall -Wextra test_frame.cpp -o /tmp/tf2                           (firmware cap mode)
#include "../agent_dial/dial_frame.h"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

static int fails = 0, checks = 0;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static std::vector<uint8_t> unhex(const std::string& s) {
  std::vector<uint8_t> v;
  for (size_t i = 0; i + 1 < s.size(); i += 2) v.push_back((uint8_t)strtol(s.substr(i, 2).c_str(), nullptr, 16));
  return v;
}
static std::string hex(const uint8_t* p, size_t n) {
  std::string s; char b[3];
  for (size_t i = 0; i < n; i++) { snprintf(b, 3, "%02x", p[i]); s += b; }
  return s;
}
struct Got { std::vector<std::string> frames; };
static void onFrame(uint8_t t, const uint8_t* p, size_t n, void* c) {
  ((Got*)c)->frames.push_back(std::to_string(t) + ":" + hex(p, n));
}
static std::vector<std::string> split(const std::string& s, char d) {
  std::vector<std::string> o; std::string cur; std::istringstream is(s);
  while (std::getline(is, cur, d)) o.push_back(cur);
  if (!s.empty() && s.back() == d) o.push_back("");
  return o;
}

int main(int argc, char** argv) {
  const char* path = argc > 1 ? argv[1] : "../../tests/vectors/dial_frame.txt";
  CHECK(dial::crc16((const uint8_t*)"123456789", 9) == 0x29B1, "crc check value");
  std::ifstream f(path);
  if (!f) { printf("cannot open %s\n", path); return 2; }
  std::string line; int enc = 0, str = 0;
  static uint8_t out[dial::kMaxFrame + 16];
  while (std::getline(f, line)) {
    if (line.empty() || line[0] == '#') continue;
    auto c = split(line, '\t');
    if (c[0] == "encode" && c.size() == 5) {
      auto payload = unhex(c[3]); auto want = unhex(c[4]);
      size_t n = dial::encode((uint8_t)atoi(c[2].c_str()), payload.data(), payload.size(), out, sizeof out);
      if (payload.size() > dial::kMaxPayload) { CHECK(n == 0, "%s: oversize must be refused", c[1].c_str()); }
      else { CHECK(n == want.size() && memcmp(out, want.data(), n) == 0, "encode %s", c[1].c_str()); }
      enc++;
    } else if (c[0] == "stream" && c.size() == 6) {
      Got g; dial::Decoder d(onFrame, &g);
      auto in = unhex(c[2]);
      // feed in one go, then again byte-by-byte: results must agree
      d.feed(in.data(), in.size());
      std::string joined; for (size_t i = 0; i < g.frames.size(); i++) joined += (i ? "," : "") + g.frames[i];
      if (joined.empty()) joined = "-";
      CHECK(joined == c[3], "stream %s frames got=%s want=%s", c[1].c_str(), joined.c_str(), c[3].c_str());
      CHECK(d.discarded() == (uint32_t)atoi(c[4].c_str()), "stream %s discarded %u", c[1].c_str(), d.discarded());
      CHECK(d.corrupt() == (uint32_t)atoi(c[5].c_str()), "stream %s corrupt %u", c[1].c_str(), d.corrupt());
      Got g2; dial::Decoder d2(onFrame, &g2);
      for (uint8_t b : in) d2.feed(&b, 1);
      CHECK(g2.frames == g.frames && d2.discarded() == d.discarded(), "stream %s bytewise", c[1].c_str());
      str++;
    }
  }
  CHECK(enc >= 10 && str >= 9, "vector counts enc=%d str=%d", enc, str);

  // Strict-bound checks (hold in both modes).
  {
    uint8_t big[dial::kMaxPayload + 1] = {0};
    CHECK(dial::encode(1, big, sizeof big, out, sizeof out) == 0, "encode refuses cap+1");
    CHECK(dial::encode(1, nullptr, 3, out, sizeof out) == 0, "encode refuses null payload");
    CHECK(dial::encode(1, big, 10, out, 17) == 0, "encode refuses small out buffer");
    CHECK(dial::encode(1, big, 10, out, 18) == 18, "encode exact fit");
    // length field lying about size: claims cap+1 -> dropped, resyncs to the good frame after it
    uint8_t lie[6] = {0xA5, 0x45, 1, 1, (uint8_t)((dial::kMaxPayload + 1) & 0xFF), (uint8_t)((dial::kMaxPayload + 1) >> 8)};
    uint8_t good[64]; size_t gn = dial::encode(1, (const uint8_t*)"{}", 2, good, sizeof good);
    Got g; dial::Decoder d(onFrame, &g);
    d.feed(lie, sizeof lie); d.feed(good, gn);
    CHECK(g.frames.size() == 1 && g.frames[0] == "1:7b7d", "oversize length resyncs");
    CHECK(d.buffered() == 0, "buffer drained");
    // 0xFFFF length
    uint8_t lie2[6] = {0xA5, 0x45, 1, 1, 0xFF, 0xFF};
    Got g3; dial::Decoder d3(onFrame, &g3);
    d3.feed(lie2, 6); d3.feed(good, gn);
    CHECK(g3.frames.size() == 1, "0xFFFF length resyncs");
  }
  if (dial::kMaxPayload < 8192) {
    // firmware cap: a frame of 2048 bytes (payload 2040) must be rejected, 2047 accepted
    static uint8_t p[2048], fr[4096];
    memset(p, 'x', sizeof p);
    CHECK(dial::kMaxFrame < 2048, "kMaxFrame %zu < 2048", dial::kMaxFrame);
    CHECK(dial::encode(1, p, 2040, fr, sizeof fr) == 0, "payload 2040 refused");
    size_t n = dial::encode(1, p, dial::kMaxPayload, fr, sizeof fr);
    CHECK(n == dial::kMaxFrame, "max payload accepted by encoder");
    Got g; dial::Decoder d(onFrame, &g); d.feed(fr, n);
    CHECK(g.frames.size() == 1, "max frame decodes");
    // hand-built 2048-byte frame with correct crc: must be dropped
    uint8_t* h = fr; size_t len = 2040;
    h[0] = 0xA5; h[1] = 0x45; h[2] = 1; h[3] = 1; h[4] = len & 0xFF; h[5] = len >> 8;
    memset(h + 6, 'x', len);
    uint16_t crc = dial::crc16(h + 2, 4 + len); h[6 + len] = crc & 0xFF; h[7 + len] = crc >> 8;
    Got g2; dial::Decoder d2(onFrame, &g2); d2.feed(h, 8 + len);
    CHECK(g2.frames.empty(), "2048-byte frame rejected");
  }
  printf("%s: %d checks, %d failures (DIAL_MAX_PAYLOAD=%zu)\n", fails ? "FAIL" : "PASS", checks, fails, dial::kMaxPayload);
  return fails ? 1 : 0;
}
