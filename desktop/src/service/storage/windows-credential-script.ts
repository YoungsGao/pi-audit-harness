// 固定脚本随 TS 打包。Key 经 stdin JSON 传入，绝不插入命令行或脚本文本。
export const credentialScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PiAuditCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct CREDENTIAL {
  public uint Flags, Type;
  [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
  [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize;
  public IntPtr CredentialBlob;
  public uint Persist, AttributeCount;
  public IntPtr Attributes;
  [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
  [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CredDelete(string target, uint type, uint flags);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
 public static void Write(string target, string key) {
  byte[] bytes=Encoding.UTF8.GetBytes(key);
  if(bytes.Length==0 || bytes.Length>2048)throw new Exception("size");
  IntPtr blob=Marshal.AllocHGlobal(bytes.Length);
  try {
   Marshal.Copy(bytes,0,blob,bytes.Length);
   CREDENTIAL value=new CREDENTIAL();
   value.Type=1; value.TargetName=target; value.Persist=2;
   value.UserName="PiAuditHarness"; value.CredentialBlob=blob;
   value.CredentialBlobSize=(uint)bytes.Length;
   if(!CredWrite(ref value,0))throw new Exception("write failed");
  } finally {
   for(int i=0;i<bytes.Length;i++){Marshal.WriteByte(blob,i,0);bytes[i]=0;}
   Marshal.FreeHGlobal(blob);
  }
 }
 public static string Read(string target) {
  IntPtr pointer;
  if(!CredRead(target,1,0,out pointer)) {
   if(Marshal.GetLastWin32Error()==1168)return null;
   throw new Exception("read failed");
  }
  try {
   CREDENTIAL value=(CREDENTIAL)Marshal.PtrToStructure(pointer,typeof(CREDENTIAL));
   if(value.CredentialBlobSize>2048)throw new Exception("size");
   byte[] bytes=new byte[value.CredentialBlobSize];
   try {Marshal.Copy(value.CredentialBlob,bytes,0,bytes.Length);return Encoding.UTF8.GetString(bytes);}
   finally {Array.Clear(bytes,0,bytes.Length);}
  } finally {CredFree(pointer);}
 }
 public static void Delete(string target) {
  if(!CredDelete(target,1,0) && Marshal.GetLastWin32Error()!=1168)throw new Exception("delete failed");
 }
}
'@
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
if($request.reference -notmatch '^PiAuditHarness/model/[a-f0-9-]{36}$'){throw 'reference'}
$secret=$null
switch($request.operation){
 'write' {[PiAuditCredential]::Write($request.reference,$request.secret)}
 'read' {$secret=[PiAuditCredential]::Read($request.reference)}
 'delete' {[PiAuditCredential]::Delete($request.reference)}
 default {throw 'operation'}
}
[Console]::Write((@{ok=$true;secret=$secret}|ConvertTo-Json -Compress))
} catch {[Console]::Write('{"ok":false}');exit 1}
`
