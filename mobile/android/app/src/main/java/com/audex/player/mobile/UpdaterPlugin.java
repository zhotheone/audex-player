package com.audex.player.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

// A sideloaded app has no store to push updates through — this mirrors
// desktop's electron-updater contract (renderer.js's checkForUpdate() is
// shared code, unaware which side implements it) using pieces Android
// already has: DownloadManager for the fetch (survives backgrounding, shows
// its own progress notification for free) and the system package installer
// for the actual install (the one step Android requires user confirmation
// for on a sideloaded app — there is no silent-install path without being a
// device-owner/system app).
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {
    private File downloadedFile = null;

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("missing url");
            return;
        }
        Context ctx = getContext();
        DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir != null && !dir.exists()) dir.mkdirs();
        File out = new File(dir, "update.apk");
        if (out.exists()) out.delete();
        downloadedFile = out;

        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
            .setDestinationUri(Uri.fromFile(out))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setTitle("Audex update")
            .setMimeType("application/vnd.android.package-archive");
        long id = dm.enqueue(req);
        pollUntilDone(call, dm, id);
    }

    // No listener API on DownloadManager — poll its own query table instead.
    // 500ms is plenty for a progress percentage the UI just renders as text.
    private void pollUntilDone(PluginCall call, DownloadManager dm, long id) {
        new Thread(() -> {
            while (true) {
                try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
                    if (c == null || !c.moveToFirst()) break;
                    int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        resolveOnUi(call, true, null);
                        return;
                    }
                    if (status == DownloadManager.STATUS_FAILED) {
                        int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                        resolveOnUi(call, false, "download failed (reason " + reason + ")");
                        return;
                    }
                    long soFar = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                    if (total > 0) {
                        JSObject p = new JSObject();
                        p.put("pct", (double) soFar / (double) total);
                        notifyListeners("downloadProgress", p);
                    }
                } catch (Exception e) {
                    resolveOnUi(call, false, String.valueOf(e.getMessage()));
                    return;
                }
                try { Thread.sleep(500); } catch (InterruptedException ignored) { return; }
            }
        }).start();
    }

    private void resolveOnUi(PluginCall call, boolean success, String error) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            ret.put("success", success);
            if (error != null) ret.put("error", error);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        if (downloadedFile == null || !downloadedFile.exists()) {
            call.reject("no downloaded update to install");
            return;
        }
        Context ctx = getContext();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", downloadedFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        call.resolve();
    }
}
