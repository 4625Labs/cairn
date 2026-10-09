/* Unit test for portal.c html_escape(). The helper source is extracted from the PATCHED
 * target/work/.../portal.c by cairn/fix/run.py and included here (HELPER_INC), so this
 * tests the code that would ship, not a copy. */
#include <stdio.h>
#include <string.h>
#include <stdbool.h>
#include <stddef.h>
#include HELPER_INC

static int fails, checks;
#define CHECK(c, msg) do { checks++; if (!(c)) { fails++; printf("FAIL: %s\n", msg); } } while (0)

static bool has_raw_meta(const char *s) { return strpbrk(s, "<>\"'") != NULL; }

/* Run the helper in a canary-guarded buffer; verifies no write past out_len. */
static void run(const char *in, size_t in_len, size_t out_len, char *res, size_t res_cap)
{
    unsigned char buf[512];
    memset(buf, 0xAB, sizeof buf);
    html_escape(in, in_len, (char *)buf, out_len);
    int guard = 1;
    for (size_t i = out_len; i < sizeof buf; i++) if (buf[i] != 0xAB) guard = 0;
    CHECK(guard, "wrote past out_len");
    CHECK(memchr(buf, 0, out_len) != NULL, "output not NUL-terminated within out_len");
    strncpy(res, (char *)buf, res_cap - 1); res[res_cap - 1] = 0;
}

int main(void)
{
    char r[512];

    run("<script>", 32, 192, r, sizeof r);
    CHECK(strcmp(r, "&lt;script&gt;") == 0, "<script> escaped exactly");

    run("\"><img onerror=1>", 32, 192, r, sizeof r);
    CHECK(strcmp(r, "&quot;&gt;&lt;img onerror=1&gt;") == 0, "\"><img onerror=1> escaped exactly");
    CHECK(!has_raw_meta(r), "no raw < > \" ' in hostile output");

    run("a&b'c", 32, 192, r, sizeof r);
    CHECK(strcmp(r, "a&amp;b&#39;c") == 0, "ampersand and apostrophe escaped");

    run("MyHomeWiFi", 32, 192, r, sizeof r);
    CHECK(strcmp(r, "MyHomeWiFi") == 0, "benign SSID unchanged");

    run("", 32, 192, r, sizeof r);
    CHECK(r[0] == 0, "empty SSID gives empty output");

    /* 32-byte SSID with no NUL terminator, all worst-case chars: 32 * 6 = 192 bytes + NUL */
    char ssid32[33]; memset(ssid32, '"', 32); ssid32[32] = 0;
    char raw32[32]; memcpy(raw32, ssid32, 32);
    run(raw32, 32, 193, r, sizeof r);
    CHECK(strlen(r) == 192 && !has_raw_meta(r), "32 x quote fits 193-byte buffer, fully escaped");

    /* 32 non-NUL bytes followed by junk: helper must stop at in_len */
    char junk[64]; memset(junk, 'A', 32); memset(junk + 32, '<', 31); junk[63] = 0;
    run(junk, 32, 192, r, sizeof r);
    CHECK(strlen(r) == 32 && !has_raw_meta(r), "input beyond the 32-byte limit is ignored");

    /* NUL inside the 32 bytes ends the string */
    run("ab\0<script>", 11, 192, r, sizeof r);
    CHECK(strcmp(r, "ab") == 0, "embedded NUL terminates");

    /* undersized output: must truncate safely, never emit a partial entity or a raw '<' */
    run("<<<<<<<<", 32, 10, r, sizeof r);
    CHECK(strlen(r) < 10 && !has_raw_meta(r), "tiny buffer truncates safely");
    CHECK(strlen(r) == 8 || strlen(r) == 4 || strlen(r) == 0, "tiny buffer holds whole entities only");

    run("<script>", 32, 1, r, sizeof r);
    CHECK(r[0] == 0, "1-byte buffer gives empty string");

    printf("html_escape: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
