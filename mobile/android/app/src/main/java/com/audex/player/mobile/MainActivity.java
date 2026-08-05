package com.audex.player.mobile;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Bundled native plugins (not npm packages) have to be registered
        // before the bridge initializes in super.onCreate().
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        // @mediagrid/capacitor-native-audio doesn't request this itself; without
        // it the media notification (lock-screen/notification controls) won't
        // show on Android 13+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
    }
}
