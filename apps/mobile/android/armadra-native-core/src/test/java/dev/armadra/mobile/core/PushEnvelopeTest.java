package dev.armadra.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Test;

public class PushEnvelopeTest {
    /** 不引 JSON 库：样本是平铺的字符串键值。 */
    private static String field(String json, String name) {
        Matcher matcher = Pattern.compile("\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        if (!matcher.find()) throw new AssertionError("no " + name);
        return matcher.group(1).replace("\\\"", "\"");
    }

    private static byte[] privateKey(String json) {
        return Base64.getUrlDecoder().decode(field(json, "privateKey"));
    }

    @Test
    public void opensWhatTheCoreSealed() throws Exception {
        String json = Fixtures.text("push-envelope.json");
        byte[] key = privateKey(json);
        assertEquals(field(json, "publicKey"), PushEnvelope.publicKey(key));
        byte[] plaintext = PushEnvelope.open(1, field(json, "alg"), field(json, "epk"), field(json, "salt"),
                field(json, "iv"), field(json, "ct"), key);
        assertEquals(field(json, "plaintext"), new String(plaintext, StandardCharsets.UTF_8));
    }

    @Test
    public void rejectsTamperingOtherKeysAndOtherAlgorithms() throws Exception {
        String json = Fixtures.text("push-envelope.json");
        byte[] key = privateKey(json);
        byte[] ct = Base64.getUrlDecoder().decode(field(json, "ct"));
        ct[0] ^= 1;
        String tampered = Base64.getUrlEncoder().withoutPadding().encodeToString(ct);
        expectFailure("undecryptable", () -> PushEnvelope.open(1, PushEnvelope.ALGORITHM, field(json, "epk"),
                field(json, "salt"), field(json, "iv"), tampered, key));
        byte[] stranger = PushEnvelope.generatePrivateKey(new SecureRandom());
        expectFailure("undecryptable", () -> PushEnvelope.open(1, PushEnvelope.ALGORITHM, field(json, "epk"),
                field(json, "salt"), field(json, "iv"), field(json, "ct"), stranger));
        expectFailure("unsupported", () -> PushEnvelope.open(2, PushEnvelope.ALGORITHM, field(json, "epk"),
                field(json, "salt"), field(json, "iv"), field(json, "ct"), key));
        expectFailure("malformed", () -> PushEnvelope.open(1, PushEnvelope.ALGORITHM, "short",
                field(json, "salt"), field(json, "iv"), field(json, "ct"), key));
    }

    @Test
    public void generatedKeysHaveA32BytePublicHalf() {
        byte[] key = PushEnvelope.generatePrivateKey(new SecureRandom());
        assertEquals(32, key.length);
        assertEquals(32, Base64.getUrlDecoder().decode(PushEnvelope.publicKey(key)).length);
        assertNotNull(PushEnvelope.KINDS);
    }

    private interface Opening {
        void run() throws Exception;
    }

    private static void expectFailure(String message, Opening opening) {
        try {
            opening.run();
            fail("expected " + message);
        } catch (PushEnvelope.EnvelopeException error) {
            assertEquals(message, error.getMessage());
        } catch (Exception error) {
            fail("unexpected " + error);
        }
    }
}
