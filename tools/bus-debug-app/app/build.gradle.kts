plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tzylxs.busdebug"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tzylxs.busdebug"
        minSdk = 24
        targetSdk = 34
        // 版本由构建传入：-PbusVersion=1.0.3.4.2 -PbusVersionCode=...
        versionCode = ((project.findProperty("busVersionCode") as String?) ?: "1").toInt()
        versionName = (project.findProperty("busVersion") as String?) ?: "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
