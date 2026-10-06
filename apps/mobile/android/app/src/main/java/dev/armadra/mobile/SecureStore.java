package dev.armadra.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 几段小秘密（每个连接的会话、远程服务登录、每个来源的钉扎、推送设备私钥）：值用 Android Keystore 里一把不可导出的
 * AES-256-GCM 钥加密后放进私有偏好。钥只在这台设备的 Keystore，备份与换机都带
 * 不走（清单里 {@code allowBackup=false}）。
 */
final class SecureStore {
    static final String DEVICE_KEY = "push.deviceKey";

    private static final String KEY_ALIAS = "dev.armadra.mobile.store";
    private static final String PREFERENCES = "armadra.secure";
    private static final int IV_LENGTH = 12;

    private final SharedPreferences preferences;

    SecureStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    synchronized String read(String name) {
        byte[] value = readBytes(name);
        return value == null ? null : new String(value, StandardCharsets.UTF_8);
    }

    synchronized boolean write(String name, String value) {
        return writeBytes(name, value.getBytes(StandardCharsets.UTF_8));
    }

    synchronized byte[] readBytes(String name) {
        String stored = preferences.getString(name, null);
        if (stored == null) return null;
        try {
            ByteBuffer sealed = ByteBuffer.wrap(Base64.decode(stored, Base64.NO_WRAP));
            byte[] iv = new byte[IV_LENGTH];
            sealed.get(iv);
            byte[] body = new byte[sealed.remaining()];
            sealed.get(body);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return cipher.doFinal(body);
        } catch (Exception error) {
            // 钥没了（清过数据、恢复了别的设备的偏好）：这条作废。
            preferences.edit().remove(name).apply();
            return null;
        }
    }

    synchronized boolean writeBytes(String name, byte[] value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] body = cipher.doFinal(value);
            ByteBuffer sealed = ByteBuffer.allocate(iv.length + body.length).put(iv).put(body);
            return preferences.edit().putString(name, Base64.encodeToString(sealed.array(), Base64.NO_WRAP)).commit();
        } catch (Exception error) {
            return false;
        }
    }

    /** 以 {@code prefix} 开头的全部条目名（多会话：一个连接一条）。 */
    synchronized List<String> names(String prefix) {
        List<String> out = new ArrayList<>();
        for (String name : preferences.getAll().keySet()) {
            if (name.startsWith(prefix)) out.add(name);
        }
        Collections.sort(out);
        return out;
    }

    synchronized void delete(String name) {
        preferences.edit().remove(name).apply();
    }

    private static SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.getKey(KEY_ALIAS, null) instanceof SecretKey existing) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                        KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
