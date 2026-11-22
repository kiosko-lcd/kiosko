// Kiosko remote screen protocol v1: crypto and framing (see ks_proto.h).
#include "ks_proto.h"
#include <string.h>
#include "mbedtls/bignum.h"
#include "mbedtls/chachapoly.h"
#include "mbedtls/ecp.h"
#include "mbedtls/hkdf.h"
#include "mbedtls/md.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"

// RFC 9382, P-256: the points M and N (uncompressed here; their discrete logs are unknown).
static const char *SPAKE_M =
    "04886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f"
    "5ff355163e43ce224e0b0e65ff02ac8e5c7be09419c785e0ca547d55a12e2d20";
static const char *SPAKE_N =
    "04d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49"
    "07d60aa6bfade45008a636337f5168c64d9bd36034808cd564490b1e656edbe7";
#define KS_ID_A "kiosko"

bool ks_equal(const uint8_t *a, const uint8_t *b, size_t n)
{
    uint8_t d = 0;
    for (size_t i = 0; i < n; i++) d |= a[i] ^ b[i];
    return d == 0;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int ks_hex_decode(const char *hex, uint8_t *out, size_t len)
{
    if (!hex || strlen(hex) != len * 2) return -1;
    for (size_t i = 0; i < len; i++) {
        int h = hexval(hex[2 * i]), l = hexval(hex[2 * i + 1]);
        if (h < 0 || l < 0) return -1;
        out[i] = (uint8_t)(h << 4 | l);
    }
    return 0;
}

void ks_hex_encode(const uint8_t *in, size_t len, char *out)
{
    static const char d[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) { out[2 * i] = d[in[i] >> 4]; out[2 * i + 1] = d[in[i] & 15]; }
    out[2 * len] = 0;
}

static const mbedtls_md_info_t *sha256(void) { return mbedtls_md_info_from_type(MBEDTLS_MD_SHA256); }

void ks_auth_mac(const uint8_t key[KS_KEY_LEN], const char *label, const uint8_t nk[KS_NONCE_LEN],
                 const uint8_t nd[KS_NONCE_LEN], const char *uid, uint8_t out[32])
{
    mbedtls_md_context_t c;
    mbedtls_md_init(&c);
    mbedtls_md_setup(&c, sha256(), 1);
    mbedtls_md_hmac_starts(&c, key, KS_KEY_LEN);
    mbedtls_md_hmac_update(&c, (const uint8_t *)label, strlen(label));
    mbedtls_md_hmac_update(&c, nk, KS_NONCE_LEN);
    mbedtls_md_hmac_update(&c, nd, KS_NONCE_LEN);
    mbedtls_md_hmac_update(&c, (const uint8_t *)uid, strlen(uid));
    mbedtls_md_hmac_finish(&c, out);
    mbedtls_md_free(&c);
}

int ks_session_init(ks_session_t *s, const uint8_t key[KS_KEY_LEN], const uint8_t nk[KS_NONCE_LEN],
                    const uint8_t nd[KS_NONCE_LEN], bool device)
{
    uint8_t salt[2 * KS_NONCE_LEN], okm[64];
    memcpy(salt, nk, KS_NONCE_LEN);
    memcpy(salt + KS_NONCE_LEN, nd, KS_NONCE_LEN);
    static const char info[] = "KSv1 session";
    int r = mbedtls_hkdf(sha256(), salt, sizeof(salt), key, KS_KEY_LEN, (const uint8_t *)info, sizeof(info) - 1, okm, sizeof(okm));
    if (r) return r;
    memcpy(device ? s->rx.key : s->tx.key, okm, 32);       // Kiosko -> screen
    memcpy(device ? s->tx.key : s->rx.key, okm + 32, 32);  // screen -> Kiosko
    s->rx.seq = s->tx.seq = 0;
    mbedtls_platform_zeroize(okm, sizeof(okm));
    return 0;
}

static void nonce_of(uint64_t seq, uint8_t n[12])
{
    memset(n, 0, 4);
    for (int i = 0; i < 8; i++) n[4 + i] = (uint8_t)(seq >> (56 - 8 * i));
}

int ks_seal(ks_dir_t *d, uint8_t *buf, size_t len, uint8_t hdr[4])
{
    uint32_t L = (uint32_t)(len + KS_TAG_LEN);
    hdr[0] = L >> 24; hdr[1] = L >> 16; hdr[2] = L >> 8; hdr[3] = L;
    uint8_t n[12];
    nonce_of(d->seq, n);
    mbedtls_chachapoly_context c;
    mbedtls_chachapoly_init(&c);
    int r = mbedtls_chachapoly_setkey(&c, d->key);
    if (!r) r = mbedtls_chachapoly_encrypt_and_tag(&c, len, n, hdr, 4, buf, buf, buf + len);
    mbedtls_chachapoly_free(&c);
    if (!r) d->seq++;
    return r;
}

int ks_open(ks_dir_t *d, const uint8_t hdr[4], uint8_t *buf, size_t len)
{
    if (len < KS_TAG_LEN) return -1;
    uint8_t n[12];
    nonce_of(d->seq, n);
    mbedtls_chachapoly_context c;
    mbedtls_chachapoly_init(&c);
    int r = mbedtls_chachapoly_setkey(&c, d->key);
    if (!r) r = mbedtls_chachapoly_auth_decrypt(&c, len - KS_TAG_LEN, n, hdr, 4, buf + len - KS_TAG_LEN, buf, buf);
    mbedtls_chachapoly_free(&c);
    // Only a message that opens moves the counter: one that doesn't ends the session anyway.
    if (!r) d->seq++;
    return r;
}

// ---- SPAKE2 -------------------------------------------------------------------

void ks_spake_w(const char *uid, const char *code, uint8_t w[32])
{
    // w = SHA256("KSv1 pake w" || uid || ":" || code) mod n. The code is good for one attempt
    // only, so a slow hash (the RFC's MHF) would add nothing: there is no offline guessing.
    mbedtls_sha256_context c;
    uint8_t h[32];
    mbedtls_sha256_init(&c);
    mbedtls_sha256_starts(&c, 0);
    mbedtls_sha256_update(&c, (const uint8_t *)"KSv1 pake w", 11);
    mbedtls_sha256_update(&c, (const uint8_t *)uid, strlen(uid));
    mbedtls_sha256_update(&c, (const uint8_t *)":", 1);
    mbedtls_sha256_update(&c, (const uint8_t *)code, strlen(code));
    mbedtls_sha256_finish(&c, h);
    mbedtls_sha256_free(&c);

    mbedtls_ecp_group g;
    mbedtls_mpi m;
    mbedtls_ecp_group_init(&g);
    mbedtls_mpi_init(&m);
    mbedtls_ecp_group_load(&g, MBEDTLS_ECP_DP_SECP256R1);
    mbedtls_mpi_read_binary(&m, h, 32);
    mbedtls_mpi_mod_mpi(&m, &m, &g.N);
    mbedtls_mpi_write_binary(&m, w, 32);
    mbedtls_mpi_free(&m);
    mbedtls_ecp_group_free(&g);
}

static int rng(void *ctx, unsigned char *out, size_t len)
{
    (void)ctx;
    ks_random(out, len);
    return 0;
}

// RFC 9382 transcript piece: 8-byte little-endian length, then the bytes.
static size_t tt_put(uint8_t *tt, size_t at, const uint8_t *p, size_t n)
{
    for (int i = 0; i < 8; i++) tt[at + i] = (uint8_t)((uint64_t)n >> (8 * i));
    memcpy(tt + at + 8, p, n);
    return at + 8 + n;
}

static void hmac(const uint8_t *k, size_t kl, const uint8_t *m, size_t ml, uint8_t out[32])
{
    mbedtls_md_hmac(sha256(), k, kl, m, ml, out);
}

#define CK(x) do { if ((r = (x)) != 0) goto out; } while (0)

int ks_spake_respond(const uint8_t w[32], const uint8_t *y_in, const uint8_t X[KS_POINT_LEN], const char *uid,
                     uint8_t Y[KS_POINT_LEN], uint8_t cB[32], uint8_t cA[32], uint8_t key[KS_KEY_LEN])
{
    int r;
    size_t olen;
    mbedtls_ecp_group g;
    mbedtls_ecp_point M, N, pX, pY, T, K, yG, wN;
    mbedtls_mpi mw, my, one, negw;
    uint8_t Kb[KS_POINT_LEN], tmp[KS_POINT_LEN], h[32], kc[64], tt[8 * 6 + 6 + 64 + 3 * KS_POINT_LEN + 32];
    if (strlen(uid) > 64) return -1;
    mbedtls_ecp_group_init(&g);
    mbedtls_ecp_point_init(&M); mbedtls_ecp_point_init(&N); mbedtls_ecp_point_init(&pX); mbedtls_ecp_point_init(&pY);
    mbedtls_ecp_point_init(&T); mbedtls_ecp_point_init(&K); mbedtls_ecp_point_init(&yG); mbedtls_ecp_point_init(&wN);
    mbedtls_mpi_init(&mw); mbedtls_mpi_init(&my); mbedtls_mpi_init(&one); mbedtls_mpi_init(&negw);

    CK(mbedtls_ecp_group_load(&g, MBEDTLS_ECP_DP_SECP256R1));
    ks_hex_decode(SPAKE_M, tmp, KS_POINT_LEN);
    CK(mbedtls_ecp_point_read_binary(&g, &M, tmp, KS_POINT_LEN));
    ks_hex_decode(SPAKE_N, tmp, KS_POINT_LEN);
    CK(mbedtls_ecp_point_read_binary(&g, &N, tmp, KS_POINT_LEN));
    // X must be a point of the curve, and not the identity.
    if (X[0] != 0x04) { r = -1; goto out; }
    CK(mbedtls_ecp_point_read_binary(&g, &pX, X, KS_POINT_LEN));
    CK(mbedtls_ecp_check_pubkey(&g, &pX));

    CK(mbedtls_mpi_read_binary(&mw, w, 32));
    if (y_in) {
        CK(mbedtls_mpi_read_binary(&my, y_in, 32));
    } else {
        CK(mbedtls_ecp_gen_privkey(&g, &my, rng, NULL));
    }
    // Y = y*G + w*N (each product with the constant-time, blinded mul; then a plain add).
    CK(mbedtls_ecp_mul(&g, &yG, &my, &g.G, rng, NULL));
    CK(mbedtls_ecp_mul(&g, &wN, &mw, &N, rng, NULL));
    CK(mbedtls_mpi_lset(&one, 1));
    CK(mbedtls_ecp_muladd(&g, &pY, &one, &yG, &one, &wN));
    CK(mbedtls_ecp_point_write_binary(&g, &pY, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, Y, KS_POINT_LEN));
    // K = y*(X - w*M); the cofactor of P-256 is 1.
    CK(mbedtls_mpi_sub_mpi(&negw, &g.N, &mw));
    CK(mbedtls_ecp_muladd(&g, &T, &one, &pX, &negw, &M));
    if (mbedtls_ecp_is_zero(&T)) { r = -1; goto out; }
    CK(mbedtls_ecp_mul(&g, &K, &my, &T, rng, NULL));
    if (mbedtls_ecp_is_zero(&K)) { r = -1; goto out; }
    CK(mbedtls_ecp_point_write_binary(&g, &K, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, Kb, KS_POINT_LEN));

    // TT = idA, idB, X, Y, K, w; h = SHA256(TT).
    size_t n = 0;
    n = tt_put(tt, n, (const uint8_t *)KS_ID_A, strlen(KS_ID_A));
    n = tt_put(tt, n, (const uint8_t *)uid, strlen(uid));
    n = tt_put(tt, n, X, KS_POINT_LEN);
    n = tt_put(tt, n, Y, KS_POINT_LEN);
    n = tt_put(tt, n, Kb, KS_POINT_LEN);
    n = tt_put(tt, n, w, 32);
    CK(mbedtls_sha256(tt, n, h, 0));
    static const char ci[] = "KSv1 confirm", ki[] = "KSv1 pair key";
    CK(mbedtls_hkdf(sha256(), NULL, 0, h, 32, (const uint8_t *)ci, sizeof(ci) - 1, kc, 64));
    CK(mbedtls_hkdf(sha256(), NULL, 0, h, 32, (const uint8_t *)ki, sizeof(ki) - 1, key, KS_KEY_LEN));
    hmac(kc, 32, tt, n, cA);
    hmac(kc + 32, 32, tt, n, cB);
    r = 0;
out:
    mbedtls_platform_zeroize(kc, sizeof(kc));
    mbedtls_platform_zeroize(h, sizeof(h));
    mbedtls_platform_zeroize(Kb, sizeof(Kb));
    mbedtls_platform_zeroize(tt, sizeof(tt));
    mbedtls_ecp_group_free(&g);
    mbedtls_ecp_point_free(&M); mbedtls_ecp_point_free(&N); mbedtls_ecp_point_free(&pX); mbedtls_ecp_point_free(&pY);
    mbedtls_ecp_point_free(&T); mbedtls_ecp_point_free(&K); mbedtls_ecp_point_free(&yG); mbedtls_ecp_point_free(&wN);
    mbedtls_mpi_free(&mw); mbedtls_mpi_free(&my); mbedtls_mpi_free(&one); mbedtls_mpi_free(&negw);
    return r;
}
