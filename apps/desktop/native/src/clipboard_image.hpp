#pragma once

#include <windows.h>
#include <optional>
#include <vector>

namespace pwtools {

enum class ClipboardImageFormat { Png, Dib };

// Normalizes untrusted clipboard image bytes into a bounded PNG. The pure
// conversion seam is also used by native fixtures, without changing the clipboard.
std::vector<BYTE> NormalizeClipboardImage(ClipboardImageFormat format, const std::vector<BYTE>& bytes);

// Clipboard-owned handles remain borrowed. This function neither writes nor
// empties the clipboard, and returns null when it contains no supported image.
std::optional<std::vector<BYTE>> ReadClipboardImage(HWND owner);

} // namespace pwtools
