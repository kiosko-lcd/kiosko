// Kiosko remote screen protocol, version 1: the crypto and the framing.
//
// Pure C over mbedTLS (no ESP-IDF), so the same file builds on the host and is
// checked there against the vectors the Kiosko driver writes
// (test/vectors.json, from packages/core/src/remote/vectors.ts). The
// protocol itself is described in docs/remote-screen.md; keep both sides in
// lockstep.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define KS_PROTO        1
#define KS_PORT         7428
#define KS_NONCE_LEN    32
#define KS_KEY_LEN      32
#define KS_TAG_LEN      16
#define KS_POINT_LEN    65   // SEC1 uncompressed P-256 point

// Message types. Before the session is up they travel in clear (type byte +
// JSON); after it, sealed (ChaCha20-Poly1305) with the type inside.
enum {
    KS_HELLO        = 0x01, // K->D {"proto":1,"nonce":hex32,"want":"session"|"pair"|"info"}
    KS_INFO         = 0x02, // D->K {"proto","uid","id","model","w","h","rot","fw","paired","pairing","nonce","max"}
    KS_AUTH         = 0x03, // K->D {"mac":hex32}
    KS_AUTH_OK      = 0x04, // D->K {"mac":hex32}; from here on, everything is sealed
    KS_ERROR        = 0x05, // D->K {"code":"...","msg":"..."}; then the device closes
    KS_PAIR_START   = 0x06, // K->D {"name":"..."}
    KS_PAIR_READY   = 0x07, // D->K {"ttl":s}: the code is on the screen
    KS_PAIR_X       = 0x08, // K->D {"X":hex65}
    KS_PAIR_Y       = 0x09, // D->K {"Y":hex65,"c":hex32}
    KS_PAIR_CONFIRM = 0x0A, // K->D {"c":hex32}
    KS_PAIR_OK      = 0x0B, // D->K {}

    KS_FRAME        = 0x10, // K->D u32 BE frame number, JPEG
    KS_ACK          = 0x11, // D->K {"n","ok","rx","dec","draw","err"?}
    KS_SET          = 0x12, // K->D {"rot"?,"id"?,"tz"?,"idle"?,"lang"?}
    KS_STATE        = 0x13, // D->K {"uid","id","model","w","h","rot","fw","last","up","heap","rssi","ip","max"}
    KS_LED          = 0x14, // K->D {"rgb":"rrggbb","blink":ms}
    KS_PING         = 0x15, // either way, {} ; answered with PONG
    KS_PONG         = 0x16,
    KS_UNPAIR       = 0x17, // K->D {} ; the device forgets the key and closes
    KS_OTA_BEGIN    = 0x18, // K->D {"size":n,"sha256":hex32}
    KS_OTA_ACK      = 0x19, // D->K {"off":n} (after BEGIN and after each DATA)
    KS_OTA_DATA     = 0x1A, // K->D raw bytes, in order
    KS_OTA_END      = 0x1B, // K->D {}
    KS_OTA_DONE     = 0x1C, // D->K {"ok":true} ; the device reboots into it
    KS_LOGS         = 0x1D, // K->D {} ; D->K {"text":"..."}
};

typedef struct {
    uint8_t key[KS_KEY_LEN];
    uint64_t seq;   // implicit: never on the wire, so a replayed or reordered message fails its tag
} ks_dir_t;

typedef struct {
    ks_dir_t rx, tx;
} ks_session_t;

// Fills `out` with random bytes (hardware RNG on the device, /dev/urandom on the host).
void ks_random(void *out, size_t len);

int ks_hex_decode(const char *hex, uint8_t *out, size_t len);   // 0 if exactly `len` bytes
void ks_hex_encode(const uint8_t *in, size_t len, char *out);    // out: 2*len+1

// HMAC-SHA256(key, label || nk || nd || uid): the proof of the pairing key on each side.
void ks_auth_mac(const uint8_t key[KS_KEY_LEN], const char *label, const uint8_t nk[KS_NONCE_LEN],
                 const uint8_t nd[KS_NONCE_LEN], const char *uid, uint8_t out[32]);
#define KS_LABEL_AUTH_K "KSv1 auth kiosko"
#define KS_LABEL_AUTH_D "KSv1 auth screen"

// Session keys: HKDF-SHA256(ikm = pairing key, salt = nk || nd, info = "KSv1 session"), 64 bytes:
// the first 32 seal Kiosko->screen, the last 32 screen->Kiosko.
int ks_session_init(ks_session_t *s, const uint8_t key[KS_KEY_LEN], const uint8_t nk[KS_NONCE_LEN],
                    const uint8_t nd[KS_NONCE_LEN], bool device);

// A sealed message on the wire: u32 BE length L, then L bytes = ciphertext || tag.
// The plaintext is type byte || payload. AAD = the 4 length bytes. Nonce = 0x00000000 || u64 BE seq.
// In place: `buf` holds the plaintext and receives ciphertext || tag (room for len + KS_TAG_LEN).
int ks_seal(ks_dir_t *d, uint8_t *buf, size_t len, uint8_t hdr[4]);
// In place: `buf` (len bytes, tag included) becomes the plaintext (len - KS_TAG_LEN bytes).
int ks_open(ks_dir_t *d, const uint8_t hdr[4], uint8_t *buf, size_t len);

// SPAKE2 (RFC 9382) over P-256 with SHA-256, the screen being B. w is derived from the code
// and the screen's uid; idA = "kiosko", idB = uid. Key schedule (256-bit, see the docs):
//   h = SHA256(TT); KcA || KcB = HKDF(h, "KSv1 confirm", 64); cA = HMAC(KcA, TT), cB = HMAC(KcB, TT);
//   key = HKDF(h, "KSv1 pair key", 32).
void ks_spake_w(const char *uid, const char *code, uint8_t w[32]);
// `y`: NULL for a random scalar (tests pass their own). Returns 0 on success, <0 if X is invalid.
int ks_spake_respond(const uint8_t w[32], const uint8_t *y, const uint8_t X[KS_POINT_LEN], const char *uid,
                     uint8_t Y[KS_POINT_LEN], uint8_t cB[32], uint8_t cA[32], uint8_t key[KS_KEY_LEN]);

// Constant-time comparison.
bool ks_equal(const uint8_t *a, const uint8_t *b, size_t n);
