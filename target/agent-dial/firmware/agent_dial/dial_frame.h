// Agent Dial USB frame codec (portable C++11, no Arduino dependency).
//
//   A5 45 | ver:u8 = 1 | type:u8 | len:u16 LE | payload[len] | crc16:u16 LE
//
// CRC-16/CCITT-FALSE over ver..payload. Format and resync rules: SPEC.md "USB".
// Fork of the OpenHarness cable framing (MIT, (c) 2026 Autonomous, Inc.), magic A5 45.
//
// SECURITY: every length is validated before it is used as an index or a copy size.
// DIAL_MAX_PAYLOAD is a hard cap. The firmware build uses 2039 so that no frame of 2048
// bytes or more is ever accepted (a whole frame is 8 + len bytes). The shared vector test
// builds with -DDIAL_MAX_PAYLOAD=8192 to match the spec's wire limit.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifndef DIAL_MAX_PAYLOAD
#define DIAL_MAX_PAYLOAD 2039
#endif

namespace dial {

constexpr uint8_t kMagic0 = 0xA5, kMagic1 = 0x45, kVersion = 1;
constexpr size_t kHeader = 6, kTrailer = 2;
constexpr size_t kMaxPayload = DIAL_MAX_PAYLOAD;
constexpr size_t kMaxFrame = kHeader + kMaxPayload + kTrailer;
static_assert(kMaxPayload <= 8192, "spec wire limit");

enum : uint8_t { kTypeJson = 1, kTypePcm = 2, kTypeLog = 4, kTypeShot = 5 };

inline uint16_t crc16(const uint8_t* data, size_t n) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < n; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

// Encodes into out. Returns the frame size, or 0 if the payload is too large for the
// cap or `cap` is too small (never truncates).
inline size_t encode(uint8_t type, const uint8_t* payload, size_t len, uint8_t* out, size_t cap) {
  if (len > kMaxPayload) return 0;
  if (len > 0 && payload == nullptr) return 0;
  const size_t total = kHeader + len + kTrailer;
  if (out == nullptr || cap < total) return 0;
  out[0] = kMagic0; out[1] = kMagic1; out[2] = kVersion; out[3] = type;
  out[4] = (uint8_t)(len & 0xFF); out[5] = (uint8_t)(len >> 8);
  if (len) memcpy(out + kHeader, payload, len);
  const uint16_t crc = crc16(out + 2, 4 + len);
  out[kHeader + len] = (uint8_t)(crc & 0xFF);
  out[kHeader + len + 1] = (uint8_t)(crc >> 8);
  return total;
}

// Streaming decoder with the spec's resync rules:
//  - bytes before a magic are discarded and counted
//  - a trailing A5 is kept in case 45 follows
//  - len over the cap, or a CRC mismatch, drops one byte and resumes the hunt
//  - a full buffer drops its oldest byte (cannot happen: the buffer holds one max frame)
// The version byte is not checked (as upstream); unknown types are passed up.
class Decoder {
 public:
  typedef void (*Handler)(uint8_t type, const uint8_t* payload, size_t len, void* ctx);

  Decoder(Handler h, void* ctx) : handler_(h), ctx_(ctx) {}

  void feed(const uint8_t* data, size_t n) {
    for (size_t i = 0; i < n; i++) {
      if (used_ == sizeof(buf_)) { dropOldest(false); }
      buf_[used_++] = data[i];
      pump();
    }
  }

  uint32_t discarded() const { return discarded_; }
  uint32_t corrupt() const { return corrupt_; }
  uint32_t frames() const { return frames_; }
  size_t buffered() const { return used_; }

 private:
  uint8_t buf_[kMaxFrame];
  size_t used_ = 0;
  uint32_t discarded_ = 0, corrupt_ = 0, frames_ = 0;
  Handler handler_;
  void* ctx_;

  void dropOldest(bool isCorrupt) {
    if (used_ == 0) return;
    memmove(buf_, buf_ + 1, used_ - 1);
    used_--;
    discarded_++;
    if (isCorrupt) corrupt_++;
  }

  void pump() {
    while (used_ > 0) {
      if (buf_[0] != kMagic0 || (used_ > 1 && buf_[1] != kMagic1)) { dropOldest(false); continue; }
      if (used_ < kHeader) return;
      const size_t len = (size_t)buf_[4] | ((size_t)buf_[5] << 8);
      if (len > kMaxPayload) { dropOldest(false); continue; }
      const size_t total = kHeader + len + kTrailer;
      if (used_ < total) return;
      const uint16_t want = (uint16_t)(buf_[kHeader + len] | (buf_[kHeader + len + 1] << 8));
      if (crc16(buf_ + 2, 4 + len) != want) { dropOldest(true); continue; }
      frames_++;
      // Copy out before the handler runs so it may not corrupt decoder state.
      const uint8_t type = buf_[3];
      if (handler_) handler_(type, buf_ + kHeader, len, ctx_);
      memmove(buf_, buf_ + total, used_ - total);
      used_ -= total;
    }
  }
};

}  // namespace dial
