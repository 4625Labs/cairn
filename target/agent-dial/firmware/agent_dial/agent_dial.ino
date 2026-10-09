// Agent Dial for the M5Stack Stopwatch: MVP firmware (Cairn build, Day 35 fork).
//
// Fork of the OpenHarness harness-device dial (MIT, (c) 2026 Autonomous, Inc.; see
// LICENSE-OPENHARNESS). Framing A5 45, hello.product "agent-dial".
//
// MVP scope (see reports/E3.md for the full spec gap list): USB link, strict frame and
// JSON validation, idle Overview, session tiles with working/recap/"Waiting for you",
// question and approval screens, Cancel task?, a drawer, toasts, "Not connected",
// BtnA/BtnB grammar, touch through the shared espt-touch warp, `answer` / `turn.stop` out.
// NOT in the MVP: LVGL/Geist (drawn with M5GFX), voice, Wi-Fi, Settings, calibration flow.
//
// Controls (lanyard down): BtnA = left, BtnB = right, both briefly = select, both held 600 ms = back.
#include <M5Unified.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <stdarg.h>
#include <new>
#include <esp_mac.h>
#include "buttons.h"
#include "dial_frame.h"
#include "touch_calibration_core.h"

SET_LOOP_TASK_STACK_SIZE(16 * 1024);  // RESULTS.md: the default 8 KB left 576 bytes free.

#define FW_VERSION "0.1-mvp"
static constexpr int W = 468, H = 466;
static constexpr int MAX_SESSIONS = 16;
static constexpr int MAX_Q = 4, MAX_OPT = 6;
static constexpr size_t CAP_ID = 47, CAP_NAME = 39, CAP_HARNESS = 11, CAP_TEXT60 = 60, CAP_SUMMARY = 160,
                        CAP_QTEXT = 199, CAP_OPT = 79, CAP_KEY = 79;
static constexpr uint32_t HELLO_IDLE_MS = 2000, HELLO_CONNECTED_MS = 15000, SILENCE_MS = 15000,
                          SLEEP_MS = 300000, TOAST_MS = 2200;

// Elapsed time always as a signed difference against a fresh millis(); stamps may be set
// by input handlers after the loop sampled its time (RESULTS.md underflow defect).
static inline int32_t since(uint32_t stamp) { return (int32_t)(millis() - stamp); }

#define C565(hex) ((uint16_t)((((hex) >> 8) & 0xF800) | (((hex) >> 5) & 0x07E0) | (((hex) >> 3) & 0x001F)))
static constexpr uint16_t COL_BG = 0x0000, COL_CARD = C565(0x23252F), COL_GREEN = C565(0x00FF2F),
                          COL_TEXT = 0xFFFF, COL_MUTED = C565(0x8A8D99), COL_AMBER = C565(0xFFB020),
                          COL_RED = C565(0xFF4D4D), COL_TOAST = C565(0x3A3D4A);

// ---------------------------------------------------------------- touch map
static touchcal::WarpMap touchMap{};
static uint16_t touchMapVersion = 0;
static uint32_t touchMapGeneration = 0;
static bool touchMapOk = false;

static bool loadTouchMap() {
  Preferences prefs;
  if (!prefs.begin(touchcal::kNvsNamespace, true)) return false;
  const size_t length = prefs.getBytesLength("record");
  touchcal::RecordV2 v2{};
  touchcal::Record v1{};
  size_t read = 0;
  if (length == sizeof(v2)) read = prefs.getBytes("record", &v2, sizeof(v2));
  else if (length == sizeof(v1)) read = prefs.getBytes("record", &v1, sizeof(v1));
  prefs.end();
  if (read == sizeof(v2) && touchcal::validateRecordV2(v2)) {
    touchMap.affine = {v2.affine[0], v2.affine[1], v2.affine[2], v2.affine[3], v2.affine[4], v2.affine[5]};
    touchMap.center = {v2.centerResidual[0], v2.centerResidual[1]};
    for (size_t r = 0; r < touchcal::kRadialRingCount; ++r)
      for (size_t s = 0; s < touchcal::kPerimeterSectorCount; ++s)
        touchMap.rings[r][s] = {v2.residuals[r][s][0], v2.residuals[r][s][1]};
    touchMapVersion = 2;
    touchMapGeneration = v2.generation;
    return touchcal::validWarp(touchMap);
  }
  if (read == sizeof(v1) && touchcal::validateRecord(v1)) {
    touchMap = touchcal::warpFromV1(v1);
    touchMapVersion = 1;
    return touchcal::validWarp(touchMap);
  }
  return false;
}

// ---------------------------------------------------------------- data model
enum Cap : uint8_t { CAP_ANSWER = 1, CAP_APPROVE = 2, CAP_STOP = 4, CAP_PROMPT = 8 };
enum Unread : uint8_t { UR_NONE, UR_DONE, UR_QUESTION };
enum Screen : uint8_t { SCR_OVERVIEW, SCR_TILE, SCR_QUESTION, SCR_DRAWER, SCR_CONFIRM };
static const char* const kScreenNames[] = {"overview", "agent", "question", "drawer", "confirm"};

struct Q {
  char key[CAP_KEY + 1];
  char text[CAP_QTEXT + 1];
  bool multi;
  uint8_t nopt;
  char opt[MAX_OPT][CAP_OPT + 1];
};
struct Question {
  char requestId[CAP_KEY + 1];
  uint8_t nq;
  Q q[MAX_Q];
  // runtime
  uint8_t cur;                    // current question index
  uint8_t cursor;                 // focused option (== nopt means Done, multi only)
  bool sel[MAX_OPT];
  char ans[MAX_Q][MAX_OPT * (CAP_OPT + 2) + 1];
};
struct Session {
  bool used, keep;
  char id[CAP_ID + 1];
  char name[CAP_NAME + 1];
  char harness[CAP_HARNESS + 1];
  uint8_t caps;
  bool working;
  uint32_t workStart;
  uint8_t verbSeed;
  char activity[CAP_TEXT60 + 1];
  char recap[CAP_SUMMARY + 1];
  Unread unread;
  Question* question;  // heap, owned
};
static Session sessions[MAX_SESSIONS];

static const char* const kVerbs[] = {"Working", "Brewing", "Cooking", "Churning", "Frosting", "Simmering", "Tinkering",
                                     "Conjuring", "Composing", "Percolating", "Wrangling", "Hatching", "Concocting",
                                     "Puttering"};
static constexpr int N_VERBS = sizeof(kVerbs) / sizeof(kVerbs[0]);

// ---------------------------------------------------------------- globals
static M5Canvas canvas(&M5.Display);
static c25k::ButtonGrammar buttons;
static Screen screen = SCR_OVERVIEW;
static Screen screenBeforeOverlay = SCR_OVERVIEW;
static int focus = -1;
static int drawerCursor = 0;
static int confirmCursor = 0;
static bool connected = false;
static bool awake = true;
static bool dirty = true;
static uint32_t lastHostRx = 0, lastHelloTx = 0, lastActivity = 0, lastDraw = 0, lastStackLog = 0;
static char toastText[64] = "";
static uint32_t toastAt = 0;
static bool toastOn = false;
static uint32_t badFrames = 0, badJson = 0, unknownT = 0, rxFrames = 0;
static uint32_t beepStart = 0, lastBeep = 0;
static int8_t beepStage = -1;
static char macStr[18] = "";

// ---------------------------------------------------------------- helpers: text safety
// Copies a UTF-8 string into dst (cap bytes incl. NUL, maxCp codepoint limit): drops control
// characters, replaces malformed or overlong sequences and non-BMP/CJK with '?', never splits a sequence.
static void sanitizeCopy(char* dst, size_t cap, const char* src, size_t srcLen, size_t maxCp) {
  size_t o = 0, cps = 0, i = 0;
  while (i < srcLen && cps < maxCp) {
    uint8_t c = (uint8_t)src[i];
    size_t need = 0;
    uint32_t cp = 0;
    if (c < 0x80) { need = 1; cp = c; }
    else if (c >= 0xC2 && c <= 0xDF) { need = 2; cp = c & 0x1F; }
    else if (c >= 0xE0 && c <= 0xEF) { need = 3; cp = c & 0x0F; }
    else if (c >= 0xF0 && c <= 0xF4) { need = 4; cp = c & 0x07; }
    bool ok = need > 0 && i + need <= srcLen;
    for (size_t k = 1; ok && k < need; k++) {
      uint8_t cc = (uint8_t)src[i + k];
      if ((cc & 0xC0) != 0x80) ok = false; else cp = (cp << 6) | (cc & 0x3F);
    }
    if (!ok) { i++; cp = '?'; need = 0; }
    else i += need;
    if (need && ((need == 3 && cp < 0x800) || (need == 4 && cp < 0x10000) || cp > 0x10FFFF)) cp = '?', need = 0;
    if (cp < 0x20 || cp == 0x7F || (cp >= 0x80 && cp < 0xA0)) continue;     // control
    if (cp >= 0xD800 && cp <= 0xDFFF) cp = '?';
    if (cp > 0x24F && cp != 0x2026 && cp != 0x2022) cp = '?';                // Latin-1/Ext-A/B only
    char enc[4]; size_t el;
    if (cp == '?' || cp < 0x80) { enc[0] = (char)cp; el = 1; }
    else if (cp < 0x800) { enc[0] = (char)(0xC0 | (cp >> 6)); enc[1] = (char)(0x80 | (cp & 0x3F)); el = 2; }
    else { enc[0] = (char)(0xE0 | (cp >> 12)); enc[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); enc[2] = (char)(0x80 | (cp & 0x3F)); el = 3; }
    if (o + el + 1 > cap) break;
    memcpy(dst + o, enc, el); o += el; cps++;
  }
  if (cap) dst[o] = 0;
}

static bool printableAscii(const char* s, size_t n) {
  for (size_t i = 0; i < n; i++) if ((uint8_t)s[i] < 0x20 || (uint8_t)s[i] > 0x7E) return false;
  return true;
}

// ---------------------------------------------------------------- USB link
static uint8_t txBuf[dial::kMaxFrame + 8];
static void sendFrame(uint8_t type, const uint8_t* p, size_t n) {
  const size_t total = dial::encode(type, p, n, txBuf, sizeof txBuf);
  if (total == 0) return;  // oversize: refused, never truncated
  Serial.write(txBuf, total);
}
static bool sendJson(const JsonDocument& doc) {
  static char out[dial::kMaxPayload + 16];
  const size_t n = serializeJson(doc, out, sizeof out);
  if (n == 0 || n > dial::kMaxPayload) return false;
  sendFrame(dial::kTypeJson, (const uint8_t*)out, n);
  return true;
}
static void adlog(const char* fmt, ...) {
  char line[200];
  va_list ap; va_start(ap, fmt);
  vsnprintf(line, sizeof line, fmt, ap);
  va_end(ap);
  if (connected) sendFrame(dial::kTypeLog, (const uint8_t*)line, strnlen(line, 511));
  else Serial.println(line);
}
static void sendSimple(const char* t, const char* id = nullptr, const char* reason = nullptr) {
  JsonDocument d;
  d["t"] = t;
  if (id) d["id"] = id;
  if (reason) d["reason"] = reason;
  sendJson(d);
}
static void sendHello() {
  JsonDocument d;
  d["t"] = "hello"; d["fw"] = FW_VERSION; d["product"] = "agent-dial"; d["proto"] = 1;
  d["hw"] = "m5stack-stopwatch"; d["mac"] = macStr; d["wifi"] = "none"; d["ip"] = "";
  d["paired"] = false; d["key"] = "-";
  sendJson(d);
  lastHelloTx = millis();
}

// ---------------------------------------------------------------- sound
static void beepNow() {
  if (since(lastBeep) < 1000 && lastBeep != 0) return;  // at most once per second
  lastBeep = millis(); lastBeep |= 1;                    // never 0 so the guard above works after boot
  beepStart = lastBeep; beepStage = 0;
  adlog("AD_SOUND beep");
}
static void beepTick() {
  if (beepStage < 0) return;
  const int32_t t = since(beepStart);
  if (t >= beepStage * 140) {
    M5.Speaker.tone(2000, 80);
    if (++beepStage >= 3) beepStage = -1;
  }
}

// ---------------------------------------------------------------- session helpers
static int findSession(const char* id) {
  for (int i = 0; i < MAX_SESSIONS; i++) if (sessions[i].used && !strcmp(sessions[i].id, id)) return i;
  return -1;
}
static int countSessions() { int n = 0; for (auto& s : sessions) n += s.used; return n; }
static int countWorking() { int n = 0; for (auto& s : sessions) n += s.used && s.working; return n; }
static int badge() { int n = 0; for (auto& s : sessions) n += s.used && s.unread != UR_NONE; return n > 8 ? 8 : n; }
static int nextSession(int from, int dir) {
  for (int k = 1; k <= MAX_SESSIONS; k++) {
    int i = ((from + dir * k) % MAX_SESSIONS + MAX_SESSIONS) % MAX_SESSIONS;
    if (sessions[i].used) return i;
  }
  return -1;
}
static void freeQuestion(Session& s) { delete s.question; s.question = nullptr; if (s.unread == UR_QUESTION) s.unread = UR_NONE; }
static void clearSession(int i) {
  freeQuestion(sessions[i]);
  sessions[i] = Session();
}
static void clearAll() {
  for (int i = 0; i < MAX_SESSIONS; i++) clearSession(i);
  focus = -1; screen = SCR_OVERVIEW; drawerCursor = confirmCursor = 0; dirty = true;
}
static void toast(const char* t) {
  sanitizeCopy(toastText, sizeof toastText, t, strlen(t), 40);
  toastAt = millis(); toastOn = true; dirty = true;
}
static void touchActivity() { lastActivity = millis(); }
static void wake() {
  if (!awake) { awake = true; M5.Display.setBrightness(200); dirty = true; }
  touchActivity();
}
static void goScreen(Screen s) { screen = s; dirty = true; }
static void setFocus(int i, bool echo) {
  if (i < 0 || !sessions[i].used) return;
  const bool changed = focus != i;
  focus = i;
  if (sessions[i].unread == UR_DONE) sessions[i].unread = UR_NONE;
  if (echo && changed) sendSimple("focus", sessions[i].id);
  dirty = true;
}
static void removeSession(int i) {
  const bool hadFocus = (focus == i);
  const bool qUp = (screen == SCR_QUESTION || screen == SCR_CONFIRM) && focus == i;
  clearSession(i);
  if (hadFocus) {
    focus = nextSession(i, 1);
    if (qUp) goScreen(focus >= 0 ? SCR_TILE : SCR_OVERVIEW);
  }
  if (countSessions() == 0) { focus = -1; if (screen != SCR_DRAWER) goScreen(SCR_OVERVIEW); }
  dirty = true;
}
static void startQuestionUi(int i) {
  Session& s = sessions[i];
  if (!s.question) return;
  s.question->cur = 0; s.question->cursor = 0;
  memset(s.question->sel, 0, sizeof s.question->sel);
  for (auto& a : s.question->ans) a[0] = 0;
  focus = i;
  goScreen(SCR_QUESTION);
}

// ---------------------------------------------------------------- answering
static bool submitAnswers(int i) {
  Session& s = sessions[i];
  if (!s.question) return false;
  JsonDocument d;
  d["t"] = "answer"; d["id"] = s.id; d["requestId"] = s.question->requestId;
  JsonObject a = d["answers"].to<JsonObject>();
  for (int k = 0; k < s.question->nq; k++) a[s.question->q[k].key] = s.question->ans[k];
  if (!sendJson(d)) { toast("Answer too large"); return false; }
  adlog("AD_EVENT answer %s", s.id);
  freeQuestion(s);
  goScreen(SCR_TILE);
  return true;
}
// Called when the person chooses option `opt` (or Done, opt == nopt) on the current question.
static void chooseOption(int i, int opt) {
  Session& s = sessions[i];
  if (!s.question) return;
  Question& Qs = *s.question;
  Q& q = Qs.q[Qs.cur];
  if (q.multi) {
    if (opt < q.nopt) { Qs.sel[opt] = !Qs.sel[opt]; dirty = true; return; }
    // Done: join selected options with ", "
    char* out = Qs.ans[Qs.cur]; size_t cap = sizeof Qs.ans[0]; out[0] = 0;
    for (int k = 0; k < q.nopt; k++) if (Qs.sel[k]) {
      if (out[0]) strlcat(out, ", ", cap);
      strlcat(out, q.opt[k], cap);
    }
  } else {
    if (opt < 0 || opt >= q.nopt) return;
    strlcpy(Qs.ans[Qs.cur], q.opt[opt], sizeof Qs.ans[0]);
  }
  if (Qs.cur + 1 < Qs.nq) {
    Qs.cur++; Qs.cursor = 0; memset(Qs.sel, 0, sizeof Qs.sel); dirty = true;
  } else {
    submitAnswers(i);
  }
}

// ---------------------------------------------------------------- user actions
static void actLeft();
static void actRight();
static void pageTile(int dir) {
  if (focus < 0) return;
  int n = nextSession(focus, dir);
  if (n >= 0) setFocus(n, true);
}
static void openDrawerRow(int i) {
  sendSimple("agent.open", sessions[i].id, sessions[i].unread == UR_QUESTION ? "question" : nullptr);
  setFocus(i, true);
  if (sessions[i].unread == UR_QUESTION && sessions[i].question) startQuestionUi(i);
  else goScreen(SCR_TILE);
}
static int drawerRows(int* idx) {  // indexes of sessions with a drawer row, at most 8
  int n = 0;
  for (int i = 0; i < MAX_SESSIONS && n < 8; i++) if (sessions[i].used && sessions[i].unread != UR_NONE) idx[n++] = i;
  return n;
}
static void actLeft() {
  switch (screen) {
    case SCR_OVERVIEW: if (focus >= 0) { setFocus(focus, true); goScreen(SCR_TILE); } break;
    case SCR_TILE: pageTile(-1); break;
    case SCR_QUESTION: {
      Question* q = sessions[focus].question; if (!q) break;
      const int slots = q->q[q->cur].nopt + (q->q[q->cur].multi ? 1 : 0);
      q->cursor = (q->cursor + slots - 1) % slots; dirty = true; break;
    }
    case SCR_DRAWER: if (drawerCursor > 0) { drawerCursor--; dirty = true; } break;
    case SCR_CONFIRM: confirmCursor = 1 - confirmCursor; dirty = true; break;
  }
}
static void actRight() {
  switch (screen) {
    case SCR_OVERVIEW: actLeft(); break;
    case SCR_TILE: pageTile(1); break;
    case SCR_QUESTION: {
      Question* q = sessions[focus].question; if (!q) break;
      const int slots = q->q[q->cur].nopt + (q->q[q->cur].multi ? 1 : 0);
      q->cursor = (q->cursor + 1) % slots; dirty = true; break;
    }
    case SCR_DRAWER: { int idx[8]; int n = drawerRows(idx); if (drawerCursor + 1 < n) { drawerCursor++; dirty = true; } break; }
    case SCR_CONFIRM: confirmCursor = 1 - confirmCursor; dirty = true; break;
  }
}
static void actEnter() {
  switch (screen) {
    case SCR_OVERVIEW:
      toast("Voice not in this build"); break;
    case SCR_TILE: {
      if (focus < 0) break;
      Session& s = sessions[focus];
      if (s.question) { startQuestionUi(focus); break; }   // MVP: Enter reopens a dismissed question
      if (!connected) { toast("Not connected"); break; }
      if (!(s.caps & CAP_PROMPT)) { toast("Can't send to this harness"); break; }
      toast("Voice not in this build"); break;
    }
    case SCR_QUESTION: {
      Question* q = sessions[focus].question; if (!q) break;
      chooseOption(focus, q->cursor); break;
    }
    case SCR_DRAWER: { int idx[8]; int n = drawerRows(idx); if (drawerCursor < n) openDrawerRow(idx[drawerCursor]); break; }
    case SCR_CONFIRM:
      if (confirmCursor == 0 && focus >= 0) {
        sendSimple("turn.stop", sessions[focus].id);
        sessions[focus].working = false; sessions[focus].activity[0] = 0;
      }
      goScreen(SCR_TILE); break;
  }
}
static void actBack() {
  switch (screen) {
    case SCR_OVERVIEW: break;
    case SCR_TILE: {
      if (focus < 0) break;
      Session& s = sessions[focus];
      if (s.working) {
        if (s.caps & CAP_STOP) { confirmCursor = 1; goScreen(SCR_CONFIRM); }
        else toast("Can't stop this from here");
      }
      break;
    }
    case SCR_QUESTION: goScreen(SCR_TILE); break;           // question and its row stay
    case SCR_DRAWER: goScreen(screenBeforeOverlay); break;
    case SCR_CONFIRM: goScreen(SCR_TILE); break;
  }
}
static void openDrawer() {
  if (screen == SCR_DRAWER || screen == SCR_QUESTION || screen == SCR_CONFIRM) return;
  screenBeforeOverlay = screen; drawerCursor = 0; goScreen(SCR_DRAWER);
}

// ---------------------------------------------------------------- inbound messages (validated)
// Strict field readers: wrong type, missing, or over-cap => the whole message is rejected.
static JsonVariantConst field(JsonObjectConst root, const char* k) {
  JsonVariantConst v = root[k];
  if (!v.isNull()) return v;
  JsonVariantConst p = root["p"];
  if (p.is<JsonObjectConst>()) return p[k];
  return JsonVariantConst();
}
static bool readId(JsonObjectConst r, char* dst) {
  JsonVariantConst v = field(r, "id");
  if (!v.is<const char*>()) return false;
  const char* s = v.as<const char*>();
  const size_t n = strlen(s);
  if (n < 1 || n > CAP_ID || !printableAscii(s, n)) return false;
  memcpy(dst, s, n + 1);
  return true;
}
static bool readStr(JsonVariantConst v, char* dst, size_t cap, size_t maxCp, bool required) {
  if (v.isNull()) { dst[0] = 0; return !required; }
  if (!v.is<const char*>()) return false;
  const char* s = v.as<const char*>();
  const size_t n = strlen(s);
  if (n > cap * 4) return false;  // absurdly long for the field: reject, do not truncate silently
  sanitizeCopy(dst, cap, s, n, maxCp);
  return !(required && dst[0] == 0);
}
static bool readKeyLike(JsonVariantConst v, char* dst, size_t maxChars) {  // key / requestId: printable ASCII 1..max
  if (!v.is<const char*>()) return false;
  const char* s = v.as<const char*>(); const size_t n = strlen(s);
  if (n < 1 || n > maxChars || !printableAscii(s, n)) return false;
  memcpy(dst, s, n + 1);
  return true;
}
static uint8_t readCaps(JsonVariantConst v) {
  uint8_t c = 0;
  if (!v.is<JsonArrayConst>()) return 0;
  int seen = 0;
  for (JsonVariantConst e : v.as<JsonArrayConst>()) {
    if (++seen > 8) break;
    const char* s = e.is<const char*>() ? e.as<const char*>() : "";
    if (!strcmp(s, "answer")) c |= CAP_ANSWER; else if (!strcmp(s, "approve")) c |= CAP_APPROVE;
    else if (!strcmp(s, "stop")) c |= CAP_STOP; else if (!strcmp(s, "prompt")) c |= CAP_PROMPT;
  }
  return c;
}
static bool upsertAgent(JsonObjectConst a, bool fromList) {
  char id[CAP_ID + 1];
  if (!readId(a, id)) return false;
  char name[CAP_NAME + 1], harness[CAP_HARNESS + 1];
  if (!readStr(field(a, "name"), name, sizeof name, CAP_NAME, false)) return false;
  if (!readStr(field(a, "harness"), harness, sizeof harness, CAP_HARNESS, false)) return false;
  int i = findSession(id);
  if (i < 0) {
    for (int k = 0; k < MAX_SESSIONS; k++) if (!sessions[k].used) { i = k; break; }
    if (i < 0) return false;  // at most 16 sessions
    sessions[i] = Session();
    sessions[i].used = true;
    strlcpy(sessions[i].id, id, sizeof sessions[i].id);
    if (focus < 0) { focus = i; dirty = true; }  // first session takes focus, no echo
  }
  Session& s = sessions[i];
  if (name[0]) strlcpy(s.name, name, sizeof s.name); else if (!s.name[0]) strlcpy(s.name, id, sizeof s.name);
  if (harness[0]) strlcpy(s.harness, harness, sizeof s.harness);
  s.caps = readCaps(field(a, "caps"));
  if (fromList) s.keep = true;
  dirty = true;
  return true;
}
static bool parseQuestion(JsonObjectConst r, Question* out) {
  if (!readKeyLike(field(r, "requestId"), out->requestId, CAP_KEY)) return false;
  JsonVariantConst qs = field(r, "questions");
  if (!qs.is<JsonArrayConst>()) return false;
  JsonArrayConst arr = qs.as<JsonArrayConst>();
  if (arr.size() < 1 || arr.size() > MAX_Q) return false;
  out->nq = 0;
  for (JsonVariantConst qv : arr) {
    if (!qv.is<JsonObjectConst>()) return false;
    JsonObjectConst qo = qv.as<JsonObjectConst>();
    Q& q = out->q[out->nq];
    if (!readKeyLike(qo["key"], q.key, CAP_KEY)) return false;
    if (!readStr(qo["q"], q.text, sizeof q.text, CAP_QTEXT, true)) return false;
    JsonVariantConst mv = qo["multi"];
    if (!mv.isNull() && !mv.is<bool>()) return false;
    q.multi = mv.is<bool>() && mv.as<bool>();
    JsonVariantConst ov = qo["options"];
    if (!ov.is<JsonArrayConst>()) return false;
    JsonArrayConst oa = ov.as<JsonArrayConst>();
    if (oa.size() < 1 || oa.size() > MAX_OPT) return false;
    q.nopt = 0;
    for (JsonVariantConst o : oa) {
      if (!readStr(o, q.opt[q.nopt], sizeof q.opt[0], CAP_OPT, true)) return false;
      q.nopt++;
    }
    out->nq++;
  }
  return true;
}

static void onHostMessage(JsonObjectConst root, const char* t) {
  if (!strcmp(t, "welcome")) {
    const bool was = connected;
    connected = true; lastHostRx = millis();
    if (!was) { adlog("AD_EVENT welcome"); sendSimple("agents.list"); }
    dirty = true; return;
  }
  if (!connected) return;  // everything below requires a live hub session
  if (!strcmp(t, "ping")) { sendSimple("pong"); return; }
  if (!strcmp(t, "agents.begin")) { for (auto& s : sessions) s.keep = false; return; }
  if (!strcmp(t, "agent")) {
    JsonVariantConst av = root["agent"];
    JsonObjectConst a = av.is<JsonObjectConst>() ? av.as<JsonObjectConst>() : root;
    if (!upsertAgent(a, true)) badJson++;
    return;
  }
  if (!strcmp(t, "agents.end")) {
    for (int i = 0; i < MAX_SESSIONS; i++) if (sessions[i].used && !sessions[i].keep) removeSession(i);
    return;
  }
  if (!strcmp(t, "toast")) { char b[64]; if (readStr(field(root, "text"), b, sizeof b, 40, true)) toast(b); else badJson++; return; }
  if (!strcmp(t, "voice.error")) { char b[64]; if (readStr(field(root, "message"), b, sizeof b, 40, true)) toast(b); return; }
  if (!strcmp(t, "voice.transcript") || !strcmp(t, "notif.replace") || !strcmp(t, "pair") || !strcmp(t, "wifi") ||
      !strcmp(t, "forget")) { adlog("AD_EVENT unsupported %.24s", t); return; }
  if (!strcmp(t, "diag.state") || !strcmp(t, "diag.act")) return;  // handled earlier (USB only)

  char id[CAP_ID + 1];
  if (!readId(root, id)) { badJson++; return; }
  const int i = findSession(id);
  if (i < 0) return;  // message about a session we do not have: ignore
  Session& s = sessions[i];
  if (!strcmp(t, "focus")) { setFocus(i, false); if (screen == SCR_OVERVIEW) goScreen(SCR_TILE); return; }
  if (!strcmp(t, "turn.started")) {
    char txt[CAP_TEXT60 + 1];
    if (!readStr(field(root, "text"), txt, sizeof txt, 60, false)) { badJson++; return; }
    if (!s.working) { s.working = true; s.workStart = millis(); s.verbSeed = (uint8_t)(esp_random() % N_VERBS); }
    strlcpy(s.activity, txt, sizeof s.activity);
    dirty = true; return;
  }
  if (!strcmp(t, "turn.done")) { s.working = false; s.activity[0] = 0; dirty = true; return; }
  if (!strcmp(t, "turn.error")) {
    char m[64]; s.working = false; s.activity[0] = 0;
    if (readStr(field(root, "message"), m, sizeof m, 40, false) && m[0]) toast(m); else toast("Turn error");
    return;
  }
  if (!strcmp(t, "summary")) {
    char txt[CAP_SUMMARY + 1];
    if (!readStr(field(root, "text"), txt, sizeof txt, 160, false)) { badJson++; return; }
    s.working = false; s.activity[0] = 0;
    strlcpy(s.recap, txt, sizeof s.recap);
    JsonVariantConst qv = field(root, "quiet");
    const bool quiet = qv.is<bool>() && qv.as<bool>();
    const bool watching = awake && screen == SCR_TILE && focus == i;
    if (s.unread != UR_QUESTION && !quiet && !watching) s.unread = UR_DONE;
    beepNow();
    if (!awake) { wake(); openDrawer(); }
    dirty = true; return;
  }
  if (!strcmp(t, "question")) {
    Question* q = new (std::nothrow) Question();
    if (!q) return;
    memset(q, 0, sizeof *q);
    if (!parseQuestion(root, q)) { delete q; badJson++; return; }
    if (s.question) delete s.question;
    s.question = q;
    s.unread = UR_QUESTION;
    wake(); beepNow();
    sendSimple("agent.open", s.id, "question");
    if (screen != SCR_QUESTION) startQuestionUi(i); else dirty = true;
    return;
  }
  if (!strcmp(t, "question.close")) {
    char rid[CAP_KEY + 1];
    if (!readKeyLike(field(root, "requestId"), rid, CAP_KEY)) { badJson++; return; }
    if (s.question && !strcmp(s.question->requestId, rid)) {
      freeQuestion(s);
      if ((screen == SCR_QUESTION || screen == SCR_CONFIRM) && focus == i) goScreen(SCR_TILE);
      dirty = true;
    }
    return;
  }
  if (!strcmp(t, "notif.seen")) { if (s.unread == UR_DONE) s.unread = UR_NONE; dirty = true; return; }
  unknownT++;
}

static void diagState() {
  JsonDocument d;
  d["t"] = "diag.state"; d["screen"] = kScreenNames[screen]; d["connected"] = connected; d["awake"] = awake;
  d["focus"] = focus >= 0 ? sessions[focus].id : "none"; d["sessions"] = countSessions();
  d["working"] = countWorking(); d["badge"] = badge(); d["voice"] = "off";
  d["bad_frames"] = badFrames; d["bad_json"] = badJson; d["unknown_t"] = unknownT; d["rx_frames"] = rxFrames;
  d["heap"] = ESP.getFreeHeap(); d["stack_free"] = uxTaskGetStackHighWaterMark(nullptr);
  sendJson(d);
}

static void onFrame(uint8_t type, const uint8_t* p, size_t n, void*) {
  rxFrames++;
  if (type != dial::kTypeJson) { unknownT++; return; }  // only JSON travels host -> device in the MVP
  if (n < 2 || memchr(p, 0, n) != nullptr) { badJson++; return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, (const char*)p, n, DeserializationOption::NestingLimit(6));
  if (err || !doc.is<JsonObject>()) { badJson++; return; }
  JsonObjectConst root = doc.as<JsonObjectConst>();
  JsonVariantConst tv = root["t"];
  if (!tv.is<const char*>()) { badJson++; return; }
  const char* t = tv.as<const char*>();
  if (strlen(t) < 1 || strlen(t) > 24) { badJson++; return; }
  if (connected) lastHostRx = millis();
  if (!strcmp(t, "diag.state")) { diagState(); return; }
  if (!strcmp(t, "diag.act")) {
    JsonVariantConst a = root["act"];
    const char* s = a.is<const char*>() ? a.as<const char*>() : "";
    wake();
    if (!strcmp(s, "left")) actLeft(); else if (!strcmp(s, "right")) actRight();
    else if (!strcmp(s, "enter")) actEnter(); else if (!strcmp(s, "back")) actBack();
    else if (!strcmp(s, "swipe_down_top")) openDrawer();
    else if (!strcmp(s, "confirm_yes")) { confirmCursor = 0; if (screen == SCR_CONFIRM) actEnter(); }
    else if (!strcmp(s, "confirm_no")) { if (screen == SCR_CONFIRM) actBack(); }
    diagState(); return;
  }
  onHostMessage(root, t);
}
static dial::Decoder decoder(onFrame, nullptr);

// ---------------------------------------------------------------- drawing
static const lgfx::IFont* F_SM = &fonts::DejaVu12;
static const lgfx::IFont* F_MD = &fonts::DejaVu18;
static const lgfx::IFont* F_LG = &fonts::DejaVu24;
static const lgfx::IFont* F_XL = &fonts::DejaVu40;
static const lgfx::IFont* F_NUM = &fonts::DejaVu72;

// Fits text into maxW pixels by dropping whole codepoints and appending "..." (ASCII, font-safe).
static void fitText(char* dst, size_t cap, const char* src, int maxW) {
  strlcpy(dst, src, cap);
  if (canvas.textWidth(dst) <= maxW) return;
  size_t len = strlen(dst);
  while (len > 0) {
    do { len--; } while (len > 0 && ((uint8_t)dst[len] & 0xC0) == 0x80);
    dst[len] = 0;
    char tmp[256]; snprintf(tmp, sizeof tmp, "%s...", dst);
    if (canvas.textWidth(tmp) <= maxW) { strlcpy(dst, tmp, cap); return; }
  }
  strlcpy(dst, "...", cap);
}
// Greedy word wrap into at most maxLines lines of maxW px; the last line is ellipsised on overflow.
static int wrapText(const char* src, int maxW, char lines[][96], int maxLines) {
  int nl = 0; char cur[96] = ""; const char* p = src;
  while (*p && nl < maxLines) {
    while (*p == ' ') p++;
    char word[96]; size_t wl = 0;
    while (*p && *p != ' ' && wl < sizeof word - 1) word[wl++] = *p++;
    word[wl] = 0;
    if (!wl) break;
    char trial[200]; snprintf(trial, sizeof trial, "%s%s%s", cur, cur[0] ? " " : "", word);
    if (canvas.textWidth(trial) <= maxW) { strlcpy(cur, trial, sizeof cur); continue; }
    if (cur[0]) { strlcpy(lines[nl++], cur, 96); cur[0] = 0; if (nl >= maxLines) { return nl; } }
    fitText(cur, sizeof cur, word, maxW);
  }
  if (cur[0] && nl < maxLines) strlcpy(lines[nl++], cur, 96);
  return nl;
}
static void textC(const char* s, int x, int y, const lgfx::IFont* f, uint16_t col) {
  canvas.setFont(f); canvas.setTextColor(col); canvas.setTextDatum(textdatum_t::middle_center);
  canvas.drawString(s, x, y);
}
static void pill(int cx, int y, int w, int h, uint16_t fill, uint16_t outline, const char* label, uint16_t tcol) {
  canvas.fillRoundRect(cx - w / 2, y, w, h, h / 2, fill);
  if (outline) for (int k = 0; k < 3; k++) canvas.drawRoundRect(cx - w / 2 + k, y + k, w - 2 * k, h - 2 * k, h / 2 - k, outline);
  char t[100]; canvas.setFont(F_MD); fitText(t, sizeof t, label, w - 36);
  textC(t, cx, y + h / 2, F_MD, tcol);
}
static const char* verbFor(const Session& s) {
  const int32_t el = since(s.workStart);
  return kVerbs[(s.verbSeed + (el > 0 ? el / 6000 : 0)) % N_VERBS];
}

static void drawOverview() {
  const int n = countSessions(), w = countWorking();
  char b[32]; snprintf(b, sizeof b, "%d", n);
  textC(b, 234, 150, F_NUM, COL_TEXT);
  textC(n == 1 ? "session" : "sessions", 234, 205, F_LG, COL_MUTED);
  if (w) { snprintf(b, sizeof b, "%d working", w); textC(b, 234, 238, F_MD, COL_GREEN); }
  else textC("All idle", 234, 238, F_MD, COL_MUTED);
  // inbox, voice, settings (touch targets, upstream positions)
  canvas.fillCircle(111, 340, 32, COL_CARD); textC("Inbox", 111, 340, F_SM, COL_TEXT);
  canvas.fillCircle(357, 340, 32, COL_CARD); textC("Set", 357, 340, F_SM, COL_MUTED);
  canvas.fillCircle(234, 390, 44, COL_CARD); textC("Mic", 234, 390, F_SM, COL_MUTED);
  const int bd = badge();
  if (bd) { canvas.fillCircle(130, 316, 12, COL_RED); snprintf(b, sizeof b, "%d", bd); textC(b, 130, 316, F_SM, COL_TEXT); }
}
static void drawTile() {
  if (focus < 0 || !sessions[focus].used) { drawOverview(); return; }
  Session& s = sessions[focus];
  char t[100];
  canvas.setFont(F_SM); fitText(t, sizeof t, s.harness[0] ? s.harness : "agent", 200);
  textC(t, 234, 92, F_SM, COL_MUTED);
  canvas.setFont(F_LG); fitText(t, sizeof t, s.name, 300);
  textC(t, 234, 119, F_LG, COL_TEXT);
  if (s.question) {
    textC("Waiting for you", 234, 205, F_LG, COL_AMBER);
    textC("Press both to answer", 234, 245, F_MD, COL_MUTED);
  } else if (s.working) {
    const int32_t el = since(s.workStart) / 1000;
    snprintf(t, sizeof t, "%s... %lds", verbFor(s), (long)(el < 0 ? 0 : el));
    textC(t, 234, 200, F_LG, COL_GREEN);
    canvas.setFont(F_MD); char a[100]; fitText(a, sizeof a, s.activity, 340);
    textC(a, 234, 240, F_MD, COL_MUTED);
  } else if (s.recap[0]) {
    canvas.fillRoundRect(42, 160, 384, 112, 28, COL_CARD);
    canvas.setFont(F_MD);
    char lines[3][96]; const int nl = wrapText(s.recap, 340, lines, 2);
    for (int k = 0; k < nl; k++) textC(lines[k], 234, 192 + 34 * k, F_MD, COL_TEXT);
  } else {
    textC("Idle", 234, 210, F_LG, COL_MUTED);
  }
  const int total = countSessions();
  if (total > 1) {
    canvas.fillCircle(100, 322, 30, COL_CARD); textC("<", 100, 322, F_LG, COL_TEXT);
    canvas.fillCircle(368, 322, 30, COL_CARD); textC(">", 368, 322, F_LG, COL_TEXT);
    int pos = 1; for (int i = 0; i < focus; i++) pos += sessions[i].used;
    snprintf(t, sizeof t, "%d / %d", pos, total); textC(t, 234, 392, F_MD, COL_MUTED);
  }
}
static void drawQuestion() {
  Session& s = sessions[focus];
  if (!s.question) { drawTile(); return; }
  Question& Qs = *s.question;
  Q& q = Qs.q[Qs.cur];
  char t[100];
  const bool approval = Qs.nq == 1 && !strcmp(q.key, "decision");
  canvas.setFont(F_SM); fitText(t, sizeof t, s.name, 180);
  if (Qs.nq > 1) { char u[140]; snprintf(u, sizeof u, "%s  %d/%d", t, Qs.cur + 1, Qs.nq); textC(u, 234, 40, F_SM, COL_MUTED); }
  else textC(approval ? "Approval" : t, 234, 40, F_SM, COL_MUTED);
  canvas.setFont(F_MD);
  char lines[3][96]; const int nl = wrapText(q.text, 300, lines, 3);
  for (int k = 0; k < nl; k++) textC(lines[k], 234, 68 + 24 * k, F_MD, COL_TEXT);
  const int slots = q.nopt + (q.multi ? 1 : 0);
  const int visible = 4;
  int top = Qs.cursor >= visible ? Qs.cursor - visible + 1 : 0;
  for (int r = 0; r < visible && top + r < slots; r++) {
    const int k = top + r, y = 160 + r * 56;
    const bool foc = (k == Qs.cursor);
    char label[CAP_OPT + 8];
    if (k == q.nopt) strlcpy(label, "Done", sizeof label);
    else if (q.multi) snprintf(label, sizeof label, "%s %s", Qs.sel[k] ? "[x]" : "[ ]", q.opt[k]);
    else strlcpy(label, q.opt[k], sizeof label);
    pill(234, y, 300, 50, COL_CARD, foc ? COL_GREEN : 0, label, foc ? COL_TEXT : COL_MUTED);
  }
  if (top > 0) textC("^", 234, 150, F_SM, COL_MUTED);
  if (top + visible < slots) textC("v", 234, 392, F_SM, COL_MUTED);
  textC("A/B move  both select  hold back", 234, 418, F_SM, COL_MUTED);
}
static void drawConfirm() {
  textC("Cancel task?", 234, 130, F_LG, COL_TEXT);
  pill(234, 190, 300, 56, COL_CARD, confirmCursor == 0 ? COL_GREEN : 0, "Yes, cancel", confirmCursor == 0 ? COL_TEXT : COL_MUTED);
  pill(234, 260, 300, 56, COL_CARD, confirmCursor == 1 ? COL_GREEN : 0, "Back", confirmCursor == 1 ? COL_TEXT : COL_MUTED);
}
static void drawDrawer() {
  textC("Inbox", 234, 56, F_LG, COL_TEXT);
  int idx[8]; const int n = drawerRows(idx);
  if (!n) { textC("Nothing new", 234, 220, F_MD, COL_MUTED); return; }
  if (drawerCursor >= n) drawerCursor = n - 1;
  const int visible = 5;
  int top = drawerCursor >= visible ? drawerCursor - visible + 1 : 0;
  for (int r = 0; r < visible && top + r < n; r++) {
    const int k = top + r, y = 92 + r * 58; Session& s = sessions[idx[k]];
    char label[120]; snprintf(label, sizeof label, "%s %s", s.unread == UR_QUESTION ? "?" : "ok", s.name);
    pill(234, y, 320, 50, COL_CARD, k == drawerCursor ? COL_GREEN : 0, label, s.unread == UR_QUESTION ? COL_AMBER : COL_TEXT);
  }
}
static void drawToastAndBadge() {
  if (!connected) {
    canvas.fillRoundRect(154, 16, 160, 28, 14, COL_CARD);
    textC("Not connected", 234, 30, F_SM, COL_MUTED);
  }
  if (toastOn) {
    char t[100]; canvas.setFont(F_MD); fitText(t, sizeof t, toastText, 320);
    const int w = canvas.textWidth(t) + 40;
    canvas.fillRoundRect(234 - w / 2, 330, w, 40, 20, COL_TOAST);
    textC(t, 234, 350, F_MD, COL_TEXT);
  }
}
static void render() {
  canvas.fillScreen(COL_BG);
  switch (screen) {
    case SCR_OVERVIEW: drawOverview(); break;
    case SCR_TILE: drawTile(); break;
    case SCR_QUESTION: drawQuestion(); break;
    case SCR_DRAWER: drawDrawer(); break;
    case SCR_CONFIRM: drawConfirm(); break;
  }
  drawToastAndBadge();
  canvas.pushSprite(0, 0);
  dirty = false; lastDraw = millis();
}

// ---------------------------------------------------------------- touch
static bool touchDown = false;
static float tx0, ty0, tx, ty;
static uint32_t touchStartMs = 0;

static bool readTouch(float* x, float* y) {
  if (touchMapOk) {
    lgfx::touch_point_t raw;
    if (M5.Display.getTouchRaw(&raw) <= 0) return false;
    auto p = touchcal::applyWarp(touchMap, {double(raw.x), double(raw.y)});
    *x = (float)p.x; *y = (float)p.y;
  } else {
    lgfx::touch_point_t tp;  // UNVERIFIED fallback: M5GFX's converted point when no record is stored
    if (M5.Display.getTouch(&tp) <= 0) return false;
    *x = tp.x; *y = tp.y;
  }
  if (!(*x == *x) || !(*y == *y)) return false;  // NaN guard
  if (*x < 0) *x = 0; if (*x > W - 1) *x = W - 1;
  if (*y < 0) *y = 0; if (*y > H - 1) *y = H - 1;
  return true;
}
static void handleTap(float x, float y) {
  switch (screen) {
    case SCR_OVERVIEW:
      if (hypotf(x - 111, y - 340) < 40) openDrawer();
      else if (hypotf(x - 234, y - 390) < 50) toast("Voice not in this build");
      else if (hypotf(x - 357, y - 340) < 40) toast("Settings not in this build");
      else if (focus >= 0) { setFocus(focus, true); goScreen(SCR_TILE); }
      break;
    case SCR_TILE:
      if (countSessions() > 1 && hypotf(x - 100, y - 322) < 40) pageTile(-1);
      else if (countSessions() > 1 && hypotf(x - 368, y - 322) < 40) pageTile(1);
      else if (focus >= 0 && sessions[focus].question) startQuestionUi(focus);
      break;
    case SCR_QUESTION: {
      Question* q = focus >= 0 ? sessions[focus].question : nullptr; if (!q) break;
      Q& cq = q->q[q->cur]; const int slots = cq.nopt + (cq.multi ? 1 : 0);
      const int visible = 4; const int top = q->cursor >= visible ? q->cursor - visible + 1 : 0;
      for (int r = 0; r < visible && top + r < slots; r++) {
        const int yy = 160 + r * 56;
        if (x >= 84 && x <= 384 && y >= yy && y <= yy + 50) { q->cursor = top + r; chooseOption(focus, top + r); break; }
      }
      break;
    }
    case SCR_DRAWER: {
      int idx[8]; const int n = drawerRows(idx);
      const int visible = 5; const int top = drawerCursor >= visible ? drawerCursor - visible + 1 : 0;
      bool hit = false;
      for (int r = 0; r < visible && top + r < n; r++) {
        const int yy = 92 + r * 58;
        if (x >= 74 && x <= 394 && y >= yy && y <= yy + 50) { openDrawerRow(idx[top + r]); hit = true; break; }
      }
      if (!hit) goScreen(screenBeforeOverlay);
      break;
    }
    case SCR_CONFIRM:
      if (x >= 84 && x <= 384 && y >= 190 && y <= 246) { confirmCursor = 0; actEnter(); }
      else if (x >= 84 && x <= 384 && y >= 260 && y <= 316) goScreen(SCR_TILE);
      break;
  }
}
static void handleSwipe(float dx, float dy, float sy) {
  if (fabsf(dx) >= fabsf(dy)) {
    if (screen == SCR_TILE) pageTile(dx < 0 ? 1 : -1);  // natural: swipe left = next
    return;
  }
  const float band = screen == SCR_TILE ? 44 : 90;
  if (dy > 0 && sy < band) { openDrawer(); return; }
  if (dy < 0 && sy >= 400) {
    if (screen == SCR_TILE) goScreen(SCR_OVERVIEW);
    else if (screen == SCR_OVERVIEW && focus >= 0) { setFocus(focus, true); goScreen(SCR_TILE); }
  }
}
static void handleTouch() {
  float x, y;
  if (readTouch(&x, &y)) {
    if (!touchDown) {
      touchDown = true; touchStartMs = millis(); tx0 = x; ty0 = y;
      if (!awake) { wake(); touchDown = false; return; }  // the waking touch is swallowed
      touchActivity();
    }
    tx = x; ty = y;
  } else if (touchDown) {
    touchDown = false;
    const float dx = tx - tx0, dy = ty - ty0, dist = hypotf(dx, dy);
    if (dist >= 55) handleSwipe(dx, dy, ty0);
    else if (dist <= 30 && since(touchStartMs) < 700) handleTap(tx, ty);
    touchActivity(); dirty = true;
  }
}

// ---------------------------------------------------------------- setup / loop
static void handleButtons() {
  const c25k::Input in = buttons.update(millis(), M5.BtnA.isPressed(), M5.BtnB.isPressed(),
                                        M5.BtnA.wasClicked(), M5.BtnB.wasClicked());
  if (in == c25k::Input::None) return;
  if (!awake) { wake(); return; }  // waking input is swallowed
  touchActivity();
  switch (in) {
    case c25k::Input::Prev: actLeft(); break;
    case c25k::Input::Next: actRight(); break;
    case c25k::Input::Enter: actEnter(); break;
    case c25k::Input::Escape: actBack(); break;
    default: break;
  }
  dirty = true;
}

void setup() {
  // HWCDC defaults to a 256-byte RX queue. The hub writes a roster + question burst (300+ bytes,
  // up to 2 KB per frame) faster than loop() drains it, and the overflow silently truncated the
  // question frame. Size it for several max frames; this must happen before begin() (begin only creates a 256 B queue if none exists).
  Serial.setRxBufferSize(4096);
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);  // a closed host port must never stall the dial
  auto cfg = M5.config();
  cfg.internal_imu = false; cfg.internal_rtc = false; cfg.internal_mic = false; cfg.internal_spk = true;
  cfg.fallback_board = m5::board_t::board_M5StopWatch;
  M5.begin(cfg);
  auto* panel = M5.Display.getPanel();
  auto pc = panel->config();
  pc.panel_width = 468; pc.panel_height = 466; pc.offset_x = 6; pc.offset_y = 0;
  panel->config(pc);
  M5.Display.setRotation(0);
  M5.Display.setBrightness(200);
  M5.Display.fillScreen(TFT_BLACK);
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  snprintf(macStr, sizeof macStr, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.printf("AD_HARDWARE board=m5stack-stopwatch w=%d h=%d fw=%s\n", M5.Display.width(), M5.Display.height(), FW_VERSION);
  touchMapOk = loadTouchMap();
  Serial.printf("AD_TOUCHMAP version=%u generation=%u ok=%d\n", touchMapVersion, (unsigned)touchMapGeneration, touchMapOk);
  M5.Speaker.begin(); M5.Speaker.setVolume(170);
  canvas.setPsram(true); canvas.setColorDepth(16);
  if (!canvas.createSprite(W, H)) { Serial.println("AD_FATAL canvas"); while (true) delay(1000); }
  lastActivity = millis();
  Serial.println("AD_SCREEN overview");
  render();
}

void loop() {
  M5.update();
  uint8_t chunk[256];
  int budget = 1024;
  while (budget > 0 && Serial.available() > 0) {
    const int n = Serial.readBytes(chunk, min<int>(sizeof chunk, min<int>(budget, Serial.available())));
    if (n <= 0) break;
    decoder.feed(chunk, (size_t)n);
    budget -= n;
  }
  badFrames = decoder.discarded();
  handleButtons();
  handleTouch();
  beepTick();

  // hub silence: after 15 s the dial clears to "Not connected"
  if (connected && since(lastHostRx) >= (int32_t)SILENCE_MS) {
    connected = false; clearAll(); adlog("AD_EVENT silence");
  }
  const uint32_t helloEvery = connected ? HELLO_CONNECTED_MS : HELLO_IDLE_MS;
  if (since(lastHelloTx) >= (int32_t)helloEvery) sendHello();
  if (toastOn && since(toastAt) >= (int32_t)TOAST_MS) { toastOn = false; dirty = true; }
  // sleep after 5 minutes idle, unless resting on a working tile
  const bool onWorking = screen == SCR_TILE && focus >= 0 && sessions[focus].working;
  if (awake && !onWorking && since(lastActivity) >= (int32_t)SLEEP_MS) { awake = false; M5.Display.setBrightness(0); }
  if (awake && onWorking && since(lastDraw) >= 1000) dirty = true;  // elapsed seconds
  if (connected && since(lastStackLog) >= 10000) {
    lastStackLog = millis();
    adlog("AD_STACK free=%u heap=%u rx=%u bad=%u json=%u", (unsigned)uxTaskGetStackHighWaterMark(nullptr),
          (unsigned)ESP.getFreeHeap(), (unsigned)rxFrames, (unsigned)badFrames, (unsigned)badJson);
  }
  if (dirty && awake) render();
  delay(5);
}
