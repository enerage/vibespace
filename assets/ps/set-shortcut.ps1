param(
  [Parameter(Mandatory = $true)][string]$LnkPath,
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [string]$Arguments = "",
  [string]$WorkingDirectory = "",
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$Aumid,
  [string]$Name = ""
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class ShortcutTools {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY { public Guid fmtid; public int pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] uint GetCount(out uint count);
    [PreserveSig] uint GetAt(uint i, out PROPERTYKEY key);
    [PreserveSig] uint GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] uint SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] uint Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BIND_OPTS { public int cbStruct; public int grfFlags; public int grfMode; public int dwTickCountDeadline; }

  [ComImport, Guid("0000000e-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IBindCtx {
    void RegisterObjectBound(IntPtr punk);
    void RevokeObjectBound(IntPtr punk);
    void ReleaseBoundObjects();
    void SetBindOptions(ref BIND_OPTS pbindopts);
    void GetBindOptions(ref BIND_OPTS pbindopts);
    void GetRunningObjectTable(out IntPtr pprot);
    void RegisterObjectParam(string pszKey, IntPtr punk);
    void GetObjectParam(string pszKey, out IntPtr ppunk);
    void EnumObjectParam(out IntPtr ppenum);
    void RevokeObjectParam(string pszKey);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(int sigdnName, out IntPtr ppszName);
    void GetAttributes(int sfgaoMask, out int psfgaoAttribs);
    void Compare(IShellItem psi, int hint, out int piOrder);
  }

  [DllImport("ole32.dll", PreserveSig = false)]
  static extern void CreateBindCtx(int reserved, out IBindCtx ppbc);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string parsingName, IntPtr bindCtx, int flags, ref Guid iid, out IPropertyStore store);

  const int GPS_READWRITE = 0x2;

  static IPropertyStore OpenRW(string path) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, GPS_READWRITE, ref iid, out store);
    return store;
  }

  static PROPERTYKEY AumidKey() {
    PROPERTYKEY k = new PROPERTYKEY();
    k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    k.pid = 5;
    return k;
  }

  public static string SetAumid(string path, string aumid) {
    IPropertyStore store = null;
    string stage = "open";
    try {
      stage = "OpenRW";
      store = OpenRW(path);

      PROPERTYKEY key = AumidKey();
      PROPVARIANT val = new PROPVARIANT();
      val.vt = 31; // VT_LPWSTR
      val.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
      stage = "SetValue";
      uint hrSet = store.SetValue(ref key, ref val);
      stage = "Commit";
      uint hrCommit = store.Commit();
      Marshal.FreeCoTaskMem(val.pointerValue);

      stage = "GetValue";
      PROPVARIANT outVal;
      store.GetValue(ref key, out outVal);
      string read = (outVal.vt == 31 && outVal.pointerValue != IntPtr.Zero)
        ? Marshal.PtrToStringUni(outVal.pointerValue) : "<empty vt=" + outVal.vt + ">";
      return String.Format("set=0x{0:X8} commit=0x{1:X8} readback={2}", hrSet, hrCommit, read);
    } catch (Exception ex) {
      return "FAILED at " + stage + ": " + ex.GetType().Name + " " + ex.Message;
    }
  }

  public static string ReadAumid(string path) {
    IPropertyStore store = OpenRW(path);
    PROPERTYKEY key = AumidKey();
    PROPVARIANT outVal;
    store.GetValue(ref key, out outVal);
    string s = (outVal.vt == 31 && outVal.pointerValue != IntPtr.Zero)
      ? Marshal.PtrToStringUni(outVal.pointerValue) : "<empty vt=" + outVal.vt + ">";
    Marshal.ReleaseComObject(store);
    return s;
  }
}
"@

$dir = Split-Path -Parent $LnkPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($LnkPath)
$sc.TargetPath = $TargetPath
if ($Arguments) { $sc.Arguments = $Arguments }
if ($WorkingDirectory) { $sc.WorkingDirectory = $WorkingDirectory }
$sc.IconLocation = "$IconPath,0"
if ($Name) { $sc.Description = $Name }
$sc.Save()
[Runtime.InteropServices.Marshal]::ReleaseComObject($sc) | Out-Null
[Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null

$result = [ShortcutTools]::SetAumid($LnkPath, $Aumid)
Write-Output "OK|$result"
