// Host test of main/ks_proto.c against the vectors Kiosko's driver writes (vectors.h).
// Run with ./test/run.sh (builds against ESP-IDF's own mbedTLS, in the same Docker image).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../main/ks_proto.h"
#include "vectors.h"

static int fails;
#define CHECK(c, what) do { if (!(c)) { printf("FAIL: %s\n", what); fails++; } else printf("ok   %s\n", what); } while (0)

void ks_random(void *out, size_t len)
{
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f || fread(out, 1, len, f) != len) abort();
    fclose(f);
}

static void hx(const char *h, uint8_t *o, size_t n) { if (ks_hex_decode(h, o, n)) { printf("bad hex\n"); exit(2); } }

int main(void)
{
    uint8_t w[32], want[64], X[65], Y[65], Yw[65], cA[32], cB[32], key[32];
    ks_spake_w(V_UID, V_CODE, w);
    hx(V_W, want, 32);
    CHECK(!memcmp(w, want, 32), "w from the code");

    uint8_t y[32];
    hx(V_Y_SCALAR, y, 32);
    hx(V_X, X, 65);
    CHECK(ks_spake_respond(w, y, X, V_UID, Y, cB, cA, key) == 0, "SPAKE2 respond");
    hx(V_Y, Yw, 65);
    CHECK(!memcmp(Y, Yw, 65), "Y");
    hx(V_CB, want, 32); CHECK(ks_equal(cB, want, 32), "cB");
    hx(V_CA, want, 32); CHECK(ks_equal(cA, want, 32), "cA");
    hx(V_PAIR_KEY, want, 32); CHECK(ks_equal(key, want, 32), "pairing key");

    // A random y still agrees on nothing secret with a wrong code (just runs), and a bad X is refused.
    uint8_t w2[32];
    ks_spake_w(V_UID, "000000", w2);
    CHECK(ks_spake_respond(w2, NULL, X, V_UID, Y, cB, cA, key) == 0, "respond with a random y");
    hx(V_CA, want, 32); CHECK(!ks_equal(cA, want, 32), "wrong code, other cA");
    uint8_t badX[65];
    memcpy(badX, X, 65); badX[40] ^= 1;
    CHECK(ks_spake_respond(w, y, badX, V_UID, Y, cB, cA, key) != 0, "a point off the curve is refused");

    uint8_t pk[32], nk[32], nd[32], mac[32];
    hx(V_PAIR_KEY, pk, 32); hx(V_NK, nk, 32); hx(V_ND, nd, 32);
    ks_auth_mac(pk, KS_LABEL_AUTH_K, nk, nd, V_UID, mac);
    hx(V_AUTH_K, want, 32); CHECK(ks_equal(mac, want, 32), "Kiosko's auth MAC");
    ks_auth_mac(pk, KS_LABEL_AUTH_D, nk, nd, V_UID, mac);
    hx(V_AUTH_D, want, 32); CHECK(ks_equal(mac, want, 32), "screen's auth MAC");

    ks_session_t s;
    CHECK(ks_session_init(&s, pk, nk, nd, true) == 0, "session keys");
    const char *msgs[] = { V_K2D_0, V_K2D_1 };
    for (int i = 0; i < 2; i++) {
        size_t n = strlen(msgs[i]) / 2;
        uint8_t *m = malloc(n);
        hx(msgs[i], m, n);
        CHECK(ks_open(&s.rx, m, m + 4, n - 4) == 0, i ? "open Kiosko's 2nd message" : "open Kiosko's 1st message");
        if (i == 0) CHECK(m[4] == 0x15 && !memcmp(m + 5, "{}", 2), "its plaintext");
        if (i == 1) {
            // Replay of the same bytes: the counter moved on, so it must not open.
            uint8_t *again = malloc(n);
            hx(msgs[i], again, n);
            ks_session_t copy = s;
            CHECK(ks_open(&copy.rx, again, again + 4, n - 4) != 0, "a replayed message is refused");
            free(again);
        }
        free(m);
    }
    // What the screen seals must be byte for byte what Kiosko expects.
    const char *pl = "{\"id\":\"desk\"}";
    uint8_t buf[64], hdr[4];
    buf[0] = 0x13;
    memcpy(buf + 1, pl, strlen(pl));
    CHECK(ks_seal(&s.tx, buf, 1 + strlen(pl), hdr) == 0, "seal");
    size_t n = strlen(V_D2K_0) / 2;
    uint8_t exp[64];
    hx(V_D2K_0, exp, n);
    CHECK(!memcmp(hdr, exp, 4) && !memcmp(buf, exp + 4, n - 4), "the screen's sealed message matches");

    printf(fails ? "\n%d FAILED\n" : "\nall passed\n", fails);
    return fails ? 1 : 0;
}
