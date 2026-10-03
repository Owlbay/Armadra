package dev.armadra.mobile.core;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.agreement.X25519Agreement;
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.X25519PublicKeyParameters;

/**
 * 推送的端到端信封（契约 §19.5）：一次性 X25519 公钥 {@code epk} 与设备公钥做 ECDH，
 * HKDF-SHA256（salt，info = {@code "armadra-push-v1" ‖ 0x00 ‖ epk ‖ 设备公钥}）派生
 * AES-256-GCM 的钥；{@code ct} = 密文 ‖ 16 字节标签。与 core {@code push/crypto.ts}
 * 逐字节对应。
 */
public final class PushEnvelope {
    public static final String ALGORITHM = "x25519-hkdf-sha256-a256gcm";
    public static final Set<String> KINDS = Set.of(
            "approval", "agentDone", "agentError", "deliveryFailed", "schedule",
            "resources", "comment", "workflowGate", "test");
    private static final byte[] INFO = "armadra-push-v1".getBytes(StandardCharsets.UTF_8);

    private PushEnvelope() {}

    /** 解不开、形状不对、算法不认识都抛它。 */
    public static final class EnvelopeException extends Exception {
        public EnvelopeException(String message) {
            super(message);
        }
    }

    /** 新的设备私钥（32 字节原始标量）。 */
    public static byte[] generatePrivateKey(SecureRandom random) {
        return new X25519PrivateKeyParameters(random).getEncoded();
    }

    /** 私钥对应的公钥，base64url 无填充——登记给 core 的就是它。 */
    public static String publicKey(byte[] privateKey) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                new X25519PrivateKeyParameters(privateKey, 0).generatePublicKey().getEncoded());
    }

    public static byte[] open(
            int version, String alg, String epk, String salt, String iv, String ct, byte[] privateKey)
            throws EnvelopeException {
        if (version != 1 || !ALGORITHM.equals(alg)) throw new EnvelopeException("unsupported");
        byte[] ephemeral;
        byte[] saltBytes;
        byte[] nonce;
        byte[] sealed;
        try {
            Base64.Decoder decoder = Base64.getUrlDecoder();
            ephemeral = decoder.decode(epk);
            saltBytes = decoder.decode(salt);
            nonce = decoder.decode(iv);
            sealed = decoder.decode(ct);
        } catch (RuntimeException error) {
            throw new EnvelopeException("malformed");
        }
        if (ephemeral.length != 32 || nonce.length != 12 || sealed.length < 16) {
            throw new EnvelopeException("malformed");
        }
        try {
            X25519PrivateKeyParameters device = new X25519PrivateKeyParameters(privateKey, 0);
            X25519Agreement agreement = new X25519Agreement();
            agreement.init(device);
            byte[] shared = new byte[agreement.getAgreementSize()];
            agreement.calculateAgreement(new X25519PublicKeyParameters(ephemeral, 0), shared, 0);
            byte[] recipient = device.generatePublicKey().getEncoded();
            byte[] info = new byte[INFO.length + 1 + 32 + 32];
            System.arraycopy(INFO, 0, info, 0, INFO.length);
            info[INFO.length] = 0;
            System.arraycopy(ephemeral, 0, info, INFO.length + 1, 32);
            System.arraycopy(recipient, 0, info, INFO.length + 33, 32);
            byte[] key = hkdf(shared, saltBytes, info);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            return cipher.doFinal(sealed);
        } catch (Exception error) {
            throw new EnvelopeException("undecryptable");
        }
    }

    /** RFC 5869，输出 32 字节（一块）。 */
    static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt.length == 0 ? new byte[32] : salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        mac.update(info);
        mac.update((byte) 1);
        return Arrays.copyOf(mac.doFinal(), 32);
    }
}
