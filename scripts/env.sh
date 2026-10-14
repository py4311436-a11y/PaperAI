# PaperAI Phase 2 — build environment (source this in Git Bash)
# Everything the Rust/MSVC toolchain needs lives on D: by user requirement.
# NOTE: the Windows SDK itself is installed under C:\Program Files (x86)\Windows
# Kits\10 by the Visual Studio installer; that cannot be relocated.

export CARGO_HOME='D:/.cargo'
export RUSTUP_HOME='D:/.rustup'
export CARGO_TARGET_DIR='D:/PaperAI-Build/target'
export RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'

# Put cargo/rustc in front of everything.
export PATH="/d/.cargo/bin:$PATH"

# MSVC + SDK, so any manual cl.exe / rc.exe invocation also works.
_MSVC="D:/PaperAI-Build/VS2022BT/VC/Tools/MSVC/14.44.35207"
_SDK="C:/Program Files (x86)/Windows Kits/10"
_SDKVER="10.0.26100.0"

export PAPERAI_MSVC_BIN="$_MSVC/bin/Hostx64/x64"
export PAPERAI_SDK_BIN="$_SDK/bin/$_SDKVER/x64"
export INCLUDE="$_MSVC/include;$_SDK/Include/$_SDKVER/ucrt;$_SDK/Include/$_SDKVER/um;$_SDK/Include/$_SDKVER/shared"
export LIB="$_MSVC/lib/x64;$_SDK/Lib/$_SDKVER/ucrt/x64;$_SDK/Lib/$_SDKVER/um/x64"
