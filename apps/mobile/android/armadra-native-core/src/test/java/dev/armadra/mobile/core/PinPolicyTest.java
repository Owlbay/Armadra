package dev.armadra.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.security.cert.X509Certificate;
import java.util.Date;
import java.util.List;
import org.junit.Test;

public class PinPolicyTest {
    private static final String CA_FP = "82e388ac1ef80d0ab28831f8bf9e0d0cde8d6b376d100c773d899e31f3ba23ca";

    @Test
    public void fingerprintMatchesTheCoreSpelling() throws Exception {
        assertEquals(CA_FP, PinPolicy.fingerprint(Fixtures.certificate("ca.pem").getEncoded()));
        assertTrue(PinPolicy.isFingerprint(CA_FP));
        assertFalse(PinPolicy.isFingerprint(CA_FP.toUpperCase()));
    }

    @Test
    public void trustsALeafSignedByThePinnedStoredAnchor() throws Exception {
        X509Certificate ca = Fixtures.certificate("ca.pem");
        Pin pin = new Pin("https://127.0.0.1:8443", CA_FP, ca.getEncoded());
        List<X509Certificate> leafOnly = List.of(Fixtures.certificate("leaf.pem"));
        assertTrue(PinPolicy.evaluate(leafOnly, pin, "127.0.0.1", Fixtures.VALID));
        assertTrue(PinPolicy.evaluate(leafOnly, pin, "192.168.1.20", Fixtures.VALID));
        assertTrue(PinPolicy.evaluate(leafOnly, pin, "ARMADRA.local", Fixtures.VALID));
    }

    @Test
    public void rejectsAnAnchorThatIsNotThePinnedOne() throws Exception {
        X509Certificate other = Fixtures.certificate("other-ca.pem");
        List<X509Certificate> leafOnly = List.of(Fixtures.certificate("leaf.pem"));
        // 存下的锚被换过：指纹对不上，没有锚。
        assertFalse(PinPolicy.evaluate(leafOnly, new Pin("https://127.0.0.1:8443", CA_FP, other.getEncoded()),
                "127.0.0.1", Fixtures.VALID));
        // 钉的是另一把同名 CA：签名验不过。
        String otherFp = PinPolicy.fingerprint(other.getEncoded());
        assertFalse(PinPolicy.evaluate(leafOnly, new Pin("https://127.0.0.1:8443", otherFp, other.getEncoded()),
                "127.0.0.1", Fixtures.VALID));
        // 没存锚、链里也没有。
        assertFalse(PinPolicy.evaluate(leafOnly, new Pin("https://127.0.0.1:8443", CA_FP, null),
                "127.0.0.1", Fixtures.VALID));
    }

    @Test
    public void rejectsAWrongHostAndAnExpiredLeaf() throws Exception {
        Pin pin = new Pin("https://127.0.0.1:8443", CA_FP, Fixtures.certificate("ca.pem").getEncoded());
        List<X509Certificate> leafOnly = List.of(Fixtures.certificate("leaf.pem"));
        assertFalse(PinPolicy.evaluate(leafOnly, pin, "10.0.0.9", Fixtures.VALID));
        assertFalse(PinPolicy.evaluate(leafOnly, pin, "evil.local", Fixtures.VALID));
        assertFalse(PinPolicy.evaluate(leafOnly, pin, "127.0.0.1", new Date(1_830_297_600_000L)));
    }

    @Test
    public void aSelfSignedLeafIsItsOwnAnchor() throws Exception {
        X509Certificate self = Fixtures.certificate("self-signed.pem");
        String fp = PinPolicy.fingerprint(self.getEncoded());
        assertTrue(PinPolicy.evaluate(List.of(self), new Pin("https://127.0.0.1:8443", fp, null),
                "127.0.0.1", Fixtures.VALID));
        assertFalse(PinPolicy.evaluate(List.of(self), new Pin("https://127.0.0.1:8443", "0".repeat(64), null),
                "127.0.0.1", Fixtures.VALID));
    }

    @Test
    public void pinsCoverOnlyTheirOwnOriginAndRoundTrip() throws Exception {
        Pin pin = new Pin("https://192.168.1.20:8443", CA_FP, Fixtures.certificate("ca.pem").getEncoded());
        assertTrue(pin.covers("192.168.1.20", 8443));
        assertFalse(pin.covers("192.168.1.20", 443));
        assertFalse(pin.covers("192.168.1.21", 8443));
        assertTrue(new Pin("https://example.test", CA_FP, null).covers("EXAMPLE.test", -1));
        Pin back = Pin.decode(pin.encode());
        assertEquals(pin.origin, back.origin);
        assertEquals(PinPolicy.fingerprint(pin.anchor), PinPolicy.fingerprint(back.anchor));
        assertNull(Pin.decode("https://h\nnot-a-fingerprint\n"));
        assertTrue(PinPolicy.isOrigin("https://192.168.1.20:8443"));
        assertFalse(PinPolicy.isOrigin("http://192.168.1.20:8443"));
        assertFalse(PinPolicy.isOrigin("https://192.168.1.20:8443/api"));
    }

    @Test
    public void parsesPemBundlesAndDer() throws Exception {
        byte[] bundle = (Fixtures.text("ca.pem") + Fixtures.text("leaf.pem")).getBytes();
        assertEquals(2, PinPolicy.certificates(bundle).size());
        assertEquals(1, PinPolicy.certificates(Fixtures.certificate("ca.pem").getEncoded()).size());
        assertEquals(0, PinPolicy.certificates("nope".getBytes()).size());
    }
}
