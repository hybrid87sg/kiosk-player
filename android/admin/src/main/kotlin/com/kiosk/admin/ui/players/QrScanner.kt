package com.kiosk.admin.ui.players

import android.content.Context
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * Opens Google's ready-made QR scanner (no camera permission needed: Google
 * Play services shows the camera itself) and reports what the code says.
 */
fun scanQrCode(context: Context, onResult: (String) -> Unit, onError: (String) -> Unit) {
    val options = GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .enableAutoZoom()
        .build()
    GmsBarcodeScanning.getClient(context, options)
        .startScan()
        .addOnSuccessListener { barcode ->
            val text = barcode.rawValue.orEmpty()
            if (text.startsWith("kiosk-pair:", ignoreCase = true)) onResult(text)
            else onError("That QR code isn't from Kiosk Player. Scan the code on the TV screen.")
        }
        .addOnFailureListener { e -> onError("The scanner couldn't start: ${e.message}. Try “Enter code instead”.") }
}
