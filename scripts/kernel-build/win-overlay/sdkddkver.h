/* NTDDI constants overlay for the 22621 SDK (OneBrowser kernel build).
 *
 * Chromium 148 compiles with -DNTDDI_VERSION=NTDDI_WIN11_GE, a constant that
 * only exists in the 26100-era sdkddkver.h. Against the 22621 headers the
 * undefined identifier makes NTDDI_VERSION evaluate to 0 inside #if, which
 * silently hides every NTDDI-gated declaration (first symptom:
 * FILE_INFO_BY_HANDLE_CLASS unknown in fileapi.h). This overlay defines the
 * missing constants before pulling in the real header. Values cross-checked
 * against the official 26100 sdkddkver.h (via the mingw-w64 mirror).
 */
#ifndef NTDDI_WIN10_CU
#define NTDDI_WIN10_CU 0x0A00000D
#endif

#ifndef NTDDI_WIN11_ZN
#define NTDDI_WIN11_ZN 0x0A00000E
#endif

#ifndef NTDDI_WIN11_GE
#define NTDDI_WIN11_GE 0x0A000010
#endif

#include_next <sdkddkver.h>
