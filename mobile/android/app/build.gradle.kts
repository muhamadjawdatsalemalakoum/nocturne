plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "space.nocturne.app"
  compileSdk = 35
  defaultConfig {
    applicationId = "space.nocturne.app"
    minSdk = 26
    targetSdk = 35
    versionCode = 2
    versionName = "0.2.0"
  }
  buildTypes {
    release { isMinifyEnabled = false }
  }
  buildFeatures { compose = true }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}

dependencies {
  val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
  implementation(composeBom)
  implementation("androidx.activity:activity-compose:1.9.2")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  // Nocturne Anywhere: BIP-340 schnorr signatures for Nostr relay events.
  // 0.19.0 is the newest release built with Kotlin 2.1 metadata — 0.20+ use
  // Kotlin 2.2/2.3 metadata that this project's Kotlin 2.0.20 cannot read.
  implementation("fr.acinq.secp256k1:secp256k1-kmp:0.19.0")
  implementation("fr.acinq.secp256k1:secp256k1-kmp-jni-android:0.19.0")

  testImplementation("junit:junit:4.13.2")
  // real org.json for JVM unit tests (the mockable android.jar stubs throw)
  testImplementation("org.json:json:20240303")
  // desktop natives so the schnorr tests run on the CI JVM without a device
  testImplementation("fr.acinq.secp256k1:secp256k1-kmp-jni-jvm:0.19.0")
}
