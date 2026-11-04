# Shepherdr Windows private-state helper.
# Fixed operations only: verify/create a private directory, read/write a private file, verify a file before another
# native client opens it, hold one core named-pipe connection open and relay it, or serve/use the private operator pipe.
# Every verification opens the real object and checks owner, DACL, type, link count and final path on that same handle;
# annotations are read from that handle too. Ancestor directory handles stay open (without FILE_SHARE_DELETE) for the
# whole operation, so a rename or junction cannot redirect the path being verified. Publication renames the held
# temporary file by handle, relative to the verified parent handle; no path is returned for another process to reopen.
# The pipeClient mode opens the pipe
# once, verifies the owner, protected DACL and server token on that connected handle, requires both this helper and the
# server to run as the same non-elevated medium-integrity user, and then relays raw bytes on the same stream; it never
# reconnects. The operator modes create a first-instance pipe with a protected current-user/SYSTEM DACL and relay
# bounded, length-prefixed JSON frames; a client passes the boot/pid handshake before any secret-bearing request. If the
# script, its policy, the pipe or the filesystem cannot answer, the operation
# is refused. Invoked by server/core/windows-security.ts, server/core/windows-pipe.ts and
# server/core/windows-operator.ts with a fixed argv and JSON on stdin; never builds a shell command.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('verifyDirectory', 'createDirectory', 'readFile', 'readPlainFile', 'readPlainFileHead', 'writeFile', 'deleteFile', 'publishPlainFile', 'verifyFile', 'verifyDescriptor', 'verifyPipeDescriptor', 'holdFile', 'pipeClient', 'operatorServer', 'operatorClient')]
  [string]$Operation
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class ShepWin
{
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint DELETE = 0x00010000;
    public const uint READ_CONTROL = 0x00020000;
    public const uint FILE_TRAVERSE = 0x00000020;
    public const uint FILE_READ_ATTRIBUTES = 0x00000080;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint FILE_SHARE_DELETE = 0x00000004;
    public const uint SYNCHRONIZE = 0x00100000;
    public const uint OPEN_EXISTING = 3;
    public const uint CREATE_NEW = 1;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    public const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    public const uint SE_FILE_OBJECT = 1;
    public const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    public const uint DACL_SECURITY_INFORMATION = 0x00000004;
    public const uint DRIVE_FIXED = 3;
    public const int FileRenameInfo = 3;
    public const int FileDispositionInfo = 4;

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION
    {
        public uint dwFileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
        public uint dwVolumeSerialNumber;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint nNumberOfLinks;
        public uint nFileIndexHigh;
        public uint nFileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateDirectoryW(string lpPathName, IntPtr lpSecurityAttributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetFileInformationByHandle(IntPtr hFile, out BY_HANDLE_FILE_INFORMATION lpFileInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetFileInformationByHandle(IntPtr hFile, int fileInformationClass, IntPtr lpFileInformation, uint dwBufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FlushFileBuffers(IntPtr hFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandleW(IntPtr hFile, StringBuilder lpszFilePath, uint cchFilePath, uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetLongPathNameW(string lpszShortPath, StringBuilder lpszLongPath, uint cchBuffer);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern uint GetDriveTypeW(string lpRootPathName);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string StringSecurityDescriptor, uint StringSDRevision, out IntPtr SecurityDescriptor, out uint SecurityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint GetSecurityInfo(IntPtr handle, uint ObjectType, uint SecurityInfo, out IntPtr ppsidOwner, out IntPtr ppsidGroup, out IntPtr ppDacl, out IntPtr ppSacl, out IntPtr ppSecurityDescriptor);

    [DllImport("advapi32.dll")]
    public static extern uint GetSecurityDescriptorLength(IntPtr pSecurityDescriptor);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LocalFree(IntPtr hMem);

    public static IntPtr OpenForRead(string path, bool directory)
    {
        uint access = GENERIC_READ | (directory ? FILE_TRAVERSE : 0);
        uint share = directory ? (FILE_SHARE_READ | FILE_SHARE_WRITE) : FILE_SHARE_READ;
        uint flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
        IntPtr handle = CreateFileW(path, access, share, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }

    public static void CreateDirectoryPrivate(string path, string sddl)
    {
        IntPtr sd;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.lpSecurityDescriptor = sd;
        sa.bInheritHandle = 0;
        IntPtr sap = Marshal.AllocHGlobal(sa.nLength);
        try
        {
            Marshal.StructureToPtr(sa, sap, false);
            if (!CreateDirectoryW(path, sap)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(sap);
            LocalFree(sd);
        }
    }

    public static IntPtr CreateFilePrivate(string path, string sddl)
    {
        IntPtr sd;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.lpSecurityDescriptor = sd;
        sa.bInheritHandle = 0;
        IntPtr sap = Marshal.AllocHGlobal(sa.nLength);
        try
        {
            Marshal.StructureToPtr(sa, sap, false);
            IntPtr handle = CreateFileW(path, GENERIC_WRITE | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES, 0, sap, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return handle;
        }
        finally
        {
            Marshal.FreeHGlobal(sap);
            LocalFree(sd);
        }
    }

    // A published file is an ordinary file: a null security descriptor means it inherits the directory's own DACL, so
    // nothing in the checkout is narrowed and nothing beyond what the directory already carries is granted. CREATE_NEW
    // means an existing name is never opened, replaced or written through. No share mode lets another handle in while
    // the bytes are still being written, and DELETE is only there so a failed attempt can remove its own object.
    public static IntPtr CreateFilePlain(string path)
    {
        uint access = GENERIC_WRITE | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
        IntPtr handle = CreateFileW(path, access, 0, IntPtr.Zero, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }

    public static byte[] SecurityBytes(IntPtr handle)
    {
        IntPtr o, g, d, s, sd;
        uint rc = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, out o, out g, out d, out s, out sd);
        if (rc != 0) throw new Win32Exception((int)rc);
        try
        {
            uint len = GetSecurityDescriptorLength(sd);
            byte[] bytes = new byte[len];
            Marshal.Copy(sd, bytes, 0, (int)len);
            return bytes;
        }
        finally { LocalFree(sd); }
    }

    public static void Info(IntPtr handle, out uint attributes, out uint links, out string identity, out ulong size)
    {
        BY_HANDLE_FILE_INFORMATION i;
        if (!GetFileInformationByHandle(handle, out i)) throw new Win32Exception(Marshal.GetLastWin32Error());
        attributes = i.dwFileAttributes;
        links = i.nNumberOfLinks;
        identity = i.dwVolumeSerialNumber.ToString("x8") + ":" + i.nFileIndexHigh.ToString("x8") + i.nFileIndexLow.ToString("x8");
        size = ((ulong)i.nFileSizeHigh << 32) | i.nFileSizeLow;
    }

    public static string FinalPath(IntPtr handle)
    {
        StringBuilder buffer = new StringBuilder(32768);
        uint n = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (n == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (n >= buffer.Capacity) throw new IOException("final path is too long");
        return buffer.ToString();
    }

    public static string LongPath(string path)
    {
        StringBuilder buffer = new StringBuilder(32768);
        uint n = GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
        if (n == 0 || n >= buffer.Capacity) return path;
        return buffer.ToString();
    }

    public static byte[] ReadAll(IntPtr handle, int length)
    {
        byte[] buffer = new byte[length];
        int total = 0;
        while (total < length)
        {
            byte[] chunk = new byte[length - total];
            uint read;
            if (!ReadFile(handle, chunk, (uint)chunk.Length, out read, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (read == 0) break;
            Buffer.BlockCopy(chunk, 0, buffer, total, (int)read);
            total += (int)read;
        }
        if (total != length) throw new IOException("file changed while being read");
        return buffer;
    }

    public static void WriteAll(IntPtr handle, byte[] data)
    {
        int total = 0;
        while (total < data.Length)
        {
            byte[] chunk = new byte[data.Length - total];
            Buffer.BlockCopy(data, total, chunk, 0, chunk.Length);
            uint written;
            if (!WriteFile(handle, chunk, (uint)chunk.Length, out written, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (written == 0) throw new IOException("short write");
            total += (int)written;
        }
    }

    // Ask the volume to write the file's data out before the name becomes visible: a best-effort data flush, so a
    // crash is less likely to leave a published name whose content is still only in the cache. It says nothing about
    // the directory entry itself and does not make the publication crash-durable. Kept separate from WriteAll so the
    // private write path keeps exactly the behaviour it had.
    public static void Flush(IntPtr handle)
    {
        if (!FlushFileBuffers(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    // Delete the file the caller just verified, through that same handle: a name swapped after verification is never the
    // object that disappears. FileDispositionInfo (4) takes one BOOLEAN, and the handle must carry DELETE access.
    public static IntPtr OpenForDelete(string path)
    {
        IntPtr handle = CreateFileW(path, DELETE | SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }

    public static void Delete(IntPtr handle)
    {
        IntPtr buffer = Marshal.AllocHGlobal(1);
        try
        {
            Marshal.WriteByte(buffer, 0, 1);
            if (!SetFileInformationByHandle(handle, FileDispositionInfo, buffer, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // Rename a held file relative to a held directory handle (SetFileInformationByHandle + FILE_RENAME_INFO). No path is
    // resolved again for the publication. FILE_RENAME_INFO layout: union (4 bytes), RootDirectory aligned to pointer
    // size, FileNameLength, then the UTF-16 name.
    public static void Rename(IntPtr file, IntPtr root, string name, bool replace)
    {
        byte[] bytes = Encoding.Unicode.GetBytes(name);
        int rootOffset = (4 + IntPtr.Size - 1) / IntPtr.Size * IntPtr.Size;
        int lengthOffset = rootOffset + IntPtr.Size;
        int nameOffset = lengthOffset + 4;
        int size = nameOffset + bytes.Length + 2;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteByte(buffer, 0, (byte)(replace ? 1 : 0));
            Marshal.WriteIntPtr(buffer, rootOffset, root);
            Marshal.WriteInt32(buffer, lengthOffset, bytes.Length);
            Marshal.Copy(bytes, 0, IntPtr.Add(buffer, nameOffset), bytes.Length);
            if (!SetFileInformationByHandle(file, FileRenameInfo, buffer, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
}

// Same-handle core pipe client. The helper opens one NamedPipeClientStream and never reopens it: owner, protected DACL
// and server process identity are read from that connected handle, and the very same stream then relays raw core
// bytes. A preflight check followed by a second open could be redirected between the two, so there is no second open.
// NamedPipeClientStream exposes no access-rights constructor in .NET Framework: PipeDirection.InOut requests
// GENERIC_READ|GENERIC_WRITE, which includes SYNCHRONIZE and READ_CONTROL, and the resulting SafePipeHandle is checked
// against the real object instead. A same-account malicious process is not defeated and no executable attestation is
// claimed; this proves the pipe object and its server process, not what the server binary does.
public sealed class ShepPipeRefusal : Exception
{
    public readonly string Code;
    public ShepPipeRefusal(string code, string message) : base(message) { Code = code; }
}

public static class ShepPipe
{
    public const string Ready = "SHEPHERDR-CORE-PIPE/1\n";
    public const uint SE_KERNEL_OBJECT = 6;
    public const uint READ_CONTROL = 0x00020000;
    public const uint SYNCHRONIZE = 0x00100000;
    // FILE_READ_DATA|FILE_WRITE_DATA|FILE_READ_EA|FILE_WRITE_EA|FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES|
    // READ_CONTROL|SYNCHRONIZE: the rights this client handle holds and the least a private core pipe must grant us.
    public const uint REQUIRED_PIPE_ACCESS = 0x0012019B;
    public const uint PIPE_FULL_CONTROL = 0x001F01FF;
    public const uint FILE_TYPE_PIPE = 3;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint PROCESS_SYNCHRONIZE = 0x00100000;
    public const uint TOKEN_QUERY = 0x0008;
    public const int TokenUser = 1;
    public const int TokenSessionId = 12;
    // Elevation and integrity are queried by class number because the names differ between .NET Framework versions.
    public const int TokenElevationClass = 20;
    public const int TokenIntegrityLevelClass = 25;
    // SECURITY_MANDATORY_MEDIUM_RID: the integrity level of an ordinary, non-elevated interactive user token.
    public const uint MediumIntegrityRid = 0x2000;
    public const int BufferSize = 65536;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint serverProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int needed);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetFileType(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    public static string CurrentUserSid()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token))
            throw new ShepPipeRefusal("UNAVAILABLE", "cannot read this process's user token (error " + Marshal.GetLastWin32Error() + ")");
        try { return TokenSid(token); }
        finally { ShepWin.CloseHandle(token); }
    }

    public static uint CurrentSession()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token))
            throw new ShepPipeRefusal("UNAVAILABLE", "cannot read this process's user token (error " + Marshal.GetLastWin32Error() + ")");
        try { return TokenSession(token); }
        finally { ShepWin.CloseHandle(token); }
    }

    static string TokenSid(IntPtr token)
    {
        int needed;
        GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw new ShepPipeRefusal("UNAVAILABLE", "this process's user token cannot be queried");
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, TokenUser, buffer, needed, out needed))
                throw new ShepPipeRefusal("UNAVAILABLE", "this process's user token cannot be queried (error " + Marshal.GetLastWin32Error() + ")");
            IntPtr sid = Marshal.ReadIntPtr(buffer);
            if (sid == IntPtr.Zero) throw new ShepPipeRefusal("UNSAFE", "this process's user token has no user SID");
            return new SecurityIdentifier(sid).Value;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static uint TokenSession(IntPtr token)
    {
        int needed;
        GetTokenInformation(token, TokenSessionId, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw new ShepPipeRefusal("UNAVAILABLE", "this process's Windows session cannot be queried");
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, TokenSessionId, buffer, needed, out needed))
                throw new ShepPipeRefusal("UNAVAILABLE", "this process's Windows session cannot be queried (error " + Marshal.GetLastWin32Error() + ")");
            return unchecked((uint)Marshal.ReadInt32(buffer));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static bool Elevated(IntPtr token)
    {
        int needed;
        GetTokenInformation(token, TokenElevationClass, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw new ShepPipeRefusal("UNAVAILABLE", "a process token's elevation cannot be queried");
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, TokenElevationClass, buffer, needed, out needed))
                throw new ShepPipeRefusal("UNAVAILABLE", "a process token's elevation cannot be queried (error " + Marshal.GetLastWin32Error() + ")");
            return Marshal.ReadInt32(buffer) != 0;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static uint IntegrityRid(IntPtr token)
    {
        int needed;
        GetTokenInformation(token, TokenIntegrityLevelClass, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw new ShepPipeRefusal("UNAVAILABLE", "a process token's integrity level cannot be queried");
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, TokenIntegrityLevelClass, buffer, needed, out needed))
                throw new ShepPipeRefusal("UNAVAILABLE", "a process token's integrity level cannot be queried (error " + Marshal.GetLastWin32Error() + ")");
            IntPtr sid = Marshal.ReadIntPtr(buffer);
            if (sid == IntPtr.Zero) throw new ShepPipeRefusal("UNSAFE", "a process token has no integrity SID");
            int count = Marshal.ReadByte(sid, 1);
            if (count < 1) throw new ShepPipeRefusal("UNSAFE", "a process token has an unreadable integrity SID");
            return unchecked((uint)Marshal.ReadInt32(sid, 8 + 4 * (count - 1)));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // The first version only serves one non-elevated user at medium integrity, on both sides of the pipe. An elevated
    // helper or an elevated server is refused instead of being trusted: a high-integrity process can write anything the
    // user could, so an "upgrade" would be a silent widening of what the core may do. This checks the account a token
    // runs as, not which executable holds it.
    static void AssertPlainUser(IntPtr token, string who)
    {
        if (Elevated(token))
            throw new ShepPipeRefusal("UNSAFE", who + " is elevated; this version only connects a core that runs as the same non-elevated, medium-integrity user");
        uint rid = IntegrityRid(token);
        if (rid != MediumIntegrityRid)
            throw new ShepPipeRefusal("UNSAFE", who + " is not running at medium integrity (level 0x" + rid.ToString("X") + "); this version only connects a core that runs as the same non-elevated, medium-integrity user");
    }

    static byte[] PipeSecurityBytes(IntPtr handle)
    {
        IntPtr owner, group, dacl, sacl, sd;
        uint rc = ShepWin.GetSecurityInfo(handle, SE_KERNEL_OBJECT,
            ShepWin.OWNER_SECURITY_INFORMATION | ShepWin.DACL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out sd);
        if (rc != 0)
            throw new ShepPipeRefusal("UNSAFE", "cannot read the core pipe's security descriptor (error " + rc + "); the pipe handle did not grant READ_CONTROL");
        try
        {
            uint length = ShepWin.GetSecurityDescriptorLength(sd);
            byte[] bytes = new byte[length];
            Marshal.Copy(sd, bytes, 0, (int)length);
            return bytes;
        }
        finally { ShepWin.LocalFree(sd); }
    }

    // Pipe rights, expanded from the documented generic aliases, are the only masks this gate reasons about. The file
    // and directory masks used for private state say nothing about a pipe.
    static uint ExpandPipeMask(uint mask)
    {
        uint generic = mask & 0xF0000000;
        uint specific = mask & 0x0FFFFFFF;
        if ((generic & 0x80000000) != 0) specific |= 0x00120089; // GENERIC_READ
        if ((generic & 0x40000000) != 0) specific |= 0x00120116; // GENERIC_WRITE
        if ((generic & 0x20000000) != 0) specific |= 0x001200A0; // GENERIC_EXECUTE
        if ((generic & 0x10000000) != 0) specific |= 0x001F01FF; // GENERIC_ALL
        return specific;
    }

    // The pipe DACL is parsed with pipe rights, never the file-and-directory masks the private-state checks use. Only a
    // protected DACL that names this account and SYSTEM, with no deny, inherited, object or unknown ACE, is accepted.
    public static void AssertDescriptor(byte[] bytes, string currentSid)
    {
        RawSecurityDescriptor sd;
        try { sd = new RawSecurityDescriptor(bytes, 0); }
        catch (Exception e) { throw new ShepPipeRefusal("UNSAFE", "the core pipe security descriptor cannot be parsed: " + e.Message); }
        if ((sd.ControlFlags & ControlFlags.SelfRelative) == 0)
            throw new ShepPipeRefusal("UNSAFE", "the core pipe security descriptor is not self-relative");
        if ((sd.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || sd.DiscretionaryAcl == null)
            throw new ShepPipeRefusal("UNSAFE", "the core pipe has no DACL");
        if ((sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0)
            throw new ShepPipeRefusal("UNSAFE", "the core pipe DACL is not protected; it inherits access from its creator");
        if (sd.Owner == null || string.IsNullOrEmpty(sd.Owner.Value))
            throw new ShepPipeRefusal("UNSAFE", "the core pipe has no verifiable owner");
        if (sd.Owner.Value != currentSid)
            throw new ShepPipeRefusal("UNSAFE", "the core pipe must be owned by you");
        uint granted = 0;
        foreach (GenericAce generic in sd.DiscretionaryAcl)
        {
            KnownAce ace = generic as KnownAce;
            if (ace == null)
                throw new ShepPipeRefusal("UNSAFE", "the core pipe has an ACE that cannot be verified");
            if (ace.AceType != AceType.AccessAllowed)
                throw new ShepPipeRefusal("UNSAFE", "the core pipe has a deny, audit or object ACE");
            if (ace.AceFlags != AceFlags.None)
                throw new ShepPipeRefusal("UNSAFE", "the core pipe has ACE flags that cannot be verified");
            uint mask = ExpandPipeMask(unchecked((uint)ace.AccessMask));
            if ((mask & ~PIPE_FULL_CONTROL) != 0)
                throw new ShepPipeRefusal("UNSAFE", "the core pipe grants rights outside the verifiable pipe set");
            string sid = ace.SecurityIdentifier == null ? "" : ace.SecurityIdentifier.Value;
            if (sid != currentSid && sid != "S-1-5-18")
                throw new ShepPipeRefusal("UNSAFE", "the core pipe grants access to another account");
            if (sid == currentSid) granted |= mask;
        }
        if ((granted & REQUIRED_PIPE_ACCESS) != REQUIRED_PIPE_ACCESS)
            throw new ShepPipeRefusal("UNSAFE", "the core pipe does not grant you the access needed to use and inspect it");
    }

    // Test seam: validates a caller-supplied security descriptor with the same pipe rules and returns nothing but a
    // refusal reason. It touches no object and grants nothing, so it cannot be used to reach a pipe.
    public static void AssertDescriptorBase64(string base64)
    {
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); }
        catch (Exception e) { throw new ShepPipeRefusal("UNSAFE", "the descriptor is not valid base64: " + e.Message); }
        AssertDescriptor(bytes, CurrentUserSid());
    }

    static void Verify(NamedPipeClientStream pipe, string pipePath)
    {
        IntPtr handle = pipe.SafePipeHandle.DangerousGetHandle();
        if (GetFileType(handle) != FILE_TYPE_PIPE)
            throw new ShepPipeRefusal("UNSAFE", pipePath + " is not a named pipe");
        string currentSid = CurrentUserSid();
        uint currentSession = CurrentSession();
        // The pipe object comes first: whether the pipe is private is a property of the pipe, not of who started this
        // helper, so that answer stays the same however Shepherdr itself was launched.
        AssertDescriptor(PipeSecurityBytes(handle), currentSid);
        IntPtr self;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out self))
            throw new ShepPipeRefusal("UNAVAILABLE", "cannot read this process's user token (error " + Marshal.GetLastWin32Error() + ")");
        try { AssertPlainUser(self, "this Shepherdr process"); }
        finally { ShepWin.CloseHandle(self); }
        uint first;
        if (!GetNamedPipeServerProcessId(handle, out first) || first == 0)
            throw new ShepPipeRefusal("UNAVAILABLE", "this Windows version cannot report the core pipe's server process; Shepherdr refuses a pipe it cannot verify");
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, first);
        if (process == IntPtr.Zero)
            throw new ShepPipeRefusal("UNSAFE", "cannot open the core pipe's server process (error " + Marshal.GetLastWin32Error() + ")");
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out token))
                throw new ShepPipeRefusal("UNSAFE", "cannot read the core pipe server's token (error " + Marshal.GetLastWin32Error() + ")");
            string serverSid = TokenSid(token);
            uint serverSession = TokenSession(token);
            AssertPlainUser(token, "the core pipe server");
            uint second;
            if (!GetNamedPipeServerProcessId(handle, out second) || second != first)
                throw new ShepPipeRefusal("UNSAFE", "the core pipe's server process changed while it was being verified");
            if (serverSid != currentSid || serverSession != currentSession)
                throw new ShepPipeRefusal("UNSAFE", "the core pipe is served by a different account or Windows session");
        }
        finally
        {
            if (token != IntPtr.Zero) ShepWin.CloseHandle(token);
            ShepWin.CloseHandle(process);
        }
    }

    // Exit codes let the client tell a refusal from a transient failure: 3 connect deadline, 4 a verified refusal
    // (permanent), 5 a broken relay, 6 unavailable without a verdict (the client may retry). Only 4 is classified as
    // refused, so retrying a pipe that may come back is never suppressed.
    static int Refuse(string code, string message)
    {
        string text = message == null ? "refused" : message.Replace("\r", " ").Replace("\n", " ");
        if (text.Length > 500) text = text.Substring(0, 500);
        Console.Error.WriteLine("shepherdr-core-pipe " + code + ": " + text);
        Console.Error.Flush();
        return code == "TIMEOUT" ? 3 : code == "UNAVAILABLE" ? 6 : 4;
    }

    // Run owns the connection from connect through verification and relay, and returns only after one relay direction
    // ended or the parent process went away. The two copy threads use fixed 64 KiB binary buffers and wait for each
    // write, so a blocked peer applies backpressure instead of growing memory. Closing this stream interrupts the
    // other direction; stdin EOF and a parent-process handle both end the helper even when stdin was inherited.
    public static int Run(Stream stdin, string pipePath, string pipeName, int connectMs, int parentPid)
    {
        NamedPipeClientStream pipe;
        try
        {
            if (connectMs < 1) connectMs = 1;
            if (connectMs > 60000) connectMs = 60000;
            pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous,
                TokenImpersonationLevel.Identification, HandleInheritability.None);
            pipe.Connect(connectMs);
        }
        catch (TimeoutException)
        {
            return Refuse("TIMEOUT", "timed out connecting to " + pipePath);
        }
        catch (Exception e)
        {
            return Refuse("UNAVAILABLE", "could not connect to " + pipePath + ": " + e.Message);
        }
        try
        {
            Verify(pipe, pipePath);
        }
        catch (ShepPipeRefusal e)
        {
            try { pipe.Dispose(); } catch (Exception) { }
            return Refuse(e.Code, e.Message);
        }
        catch (EntryPointNotFoundException)
        {
            // GetNamedPipeServerProcessId needs Windows 8 / Server 2012 or newer. A pipe this helper cannot inspect is
            // refused rather than relayed on trust.
            try { pipe.Dispose(); } catch (Exception) { }
            return Refuse("UNAVAILABLE", "this Windows version cannot report the connected pipe's server process, so " + pipePath + " cannot be verified; Shepherdr refuses it");
        }
        catch (Exception e)
        {
            try { pipe.Dispose(); } catch (Exception) { }
            return Refuse("UNAVAILABLE", "could not verify " + pipePath + ": " + e.Message);
        }

        // Watch the parent before announcing readiness. A helper whose supervisor cannot be watched would otherwise
        // hand back a connection it can never release: stdin may be inherited and stay open after the parent dies.
        IntPtr parent = IntPtr.Zero;
        if (parentPid > 0)
        {
            parent = OpenProcess(PROCESS_SYNCHRONIZE, false, unchecked((uint)parentPid));
            if (parent == IntPtr.Zero)
            {
                try { pipe.Dispose(); } catch (Exception) { }
                return Refuse("UNAVAILABLE", "parent process " + parentPid + " is gone or cannot be watched");
            }
        }

        Stream stdout = Console.OpenStandardOutput();
        try
        {
            byte[] ready = Encoding.ASCII.GetBytes(Ready);
            stdout.Write(ready, 0, ready.Length);
            stdout.Flush();
        }
        catch (Exception e)
        {
            if (parent != IntPtr.Zero) ShepWin.CloseHandle(parent);
            try { pipe.Dispose(); } catch (Exception) { }
            return Refuse("UNAVAILABLE", "could not announce readiness: " + e.Message);
        }

        ManualResetEvent done = new ManualResetEvent(false);
        int finished = 0;
        int fault = 0;
        Action<int> finish = delegate(int code)
        {
            if (code == 1) Interlocked.Exchange(ref fault, 1);
            if (Interlocked.Exchange(ref finished, 1) == 0) done.Set();
        };
        Thread up = new Thread(delegate()
        {
            byte[] buffer = new byte[BufferSize];
            try
            {
                while (true)
                {
                    int read = stdin.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    Task write = pipe.WriteAsync(buffer, 0, read);
                    write.Wait();
                }
            }
            catch (Exception) { finish(1); return; }
            finish(0);
        });
        Thread down = new Thread(delegate()
        {
            byte[] buffer = new byte[BufferSize];
            try
            {
                while (true)
                {
                    Task<int> read = pipe.ReadAsync(buffer, 0, buffer.Length);
                    read.Wait();
                    int count = read.Result;
                    if (count <= 0) break;
                    stdout.Write(buffer, 0, count);
                    stdout.Flush();
                }
            }
            catch (Exception) { finish(1); return; }
            finish(0);
        });
        up.IsBackground = true;
        down.IsBackground = true;

        if (parent != IntPtr.Zero)
        {
            Thread watch = new Thread(delegate()
            {
                WaitForSingleObject(parent, 0xFFFFFFFF);
                finish(2);
            });
            watch.IsBackground = true;
            watch.Start();
        }

        up.Start();
        down.Start();
        done.WaitOne();
        try { pipe.Dispose(); } catch (Exception) { }
        if (parent != IntPtr.Zero) ShepWin.CloseHandle(parent);
        // 0 means one direction ended normally (the core closed its end, or Shepherdr closed stdin) and this helper closed
        // the pipe with it. Any other exit tells the caller the relay broke, so it can surface an error instead of a
        // clean end of stream.
        return fault != 0 ? 5 : 0;
    }

    // ---- Private operator pipe ----
    // Bun cannot create a Windows named pipe with a chosen DACL, so the fixed helper creates and holds the operator pipe
    // and relays bounded, length-prefixed frames to the application over its own stdin/stdout. The pipe is created with
    // FILE_FLAG_FIRST_PIPE_INSTANCE and a protected DACL that names this account and SYSTEM only; remote clients are
    // rejected by the pipe mode. Nothing here authenticates an executable: the trust is "same account, same session,
    // same non-elevated medium integrity", and an administrator takeover is out of scope.
    public const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    public const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    public const uint PIPE_TYPE_BYTE = 0x00000000;
    public const uint PIPE_READMODE_BYTE = 0x00000000;
    public const uint PIPE_WAIT = 0x00000000;
    public const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
    public const int ERROR_ACCESS_DENIED = 5;
    public const int ERROR_BROKEN_PIPE = 109;
    public const int ERROR_PIPE_NOT_CONNECTED = 233;
    public const int ERROR_PIPE_CONNECTED = 535;
    public const int OperatorFrameLimit = 512 * 1024;
    public const int OperatorHelloLimit = 4096;
    public const int OperatorWriteMs = 15000;

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateNamedPipeW(string lpName, uint dwOpenMode, uint dwPipeMode, uint nMaxInstances,
        uint nOutBufferSize, uint nInBufferSize, uint nDefaultTimeOut, IntPtr lpSecurityAttributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ConnectNamedPipe(IntPtr hNamedPipe, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DisconnectNamedPipe(IntPtr hNamedPipe);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool PeekNamedPipe(IntPtr hNamedPipe, IntPtr lpBuffer, uint nBufferSize, IntPtr lpBytesRead,
        out uint lpTotalBytesAvail, IntPtr lpBytesLeftThisMessage);

    // The SDDL is built by the caller from the current user's SID; this gate still re-reads the descriptor from the real
    // handle, so a descriptor that failed to install is refused instead of trusted because it was requested.
    public static IntPtr OperatorCreate(string pipePath, string sddl, int parentPid)
    {
        IntPtr raw;
        uint size;
        if (!ShepWin.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out raw, out size))
            throw new ShepPipeRefusal("UNSAFE", "cannot build the private operator pipe DACL (error " + Marshal.GetLastWin32Error() + ")");
        IntPtr attributes = IntPtr.Zero;
        IntPtr handle = IntPtr.Zero;
        try
        {
            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.lpSecurityDescriptor = raw;
            sa.bInheritHandle = false;
            attributes = Marshal.AllocHGlobal(sa.nLength);
            Marshal.StructureToPtr(sa, attributes, false);
            handle = CreateNamedPipeW(pipePath,
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1, BufferSize, BufferSize, 0, attributes);
            if (handle == new IntPtr(-1))
            {
                int error = Marshal.GetLastWin32Error();
                handle = IntPtr.Zero;
                if (error == ERROR_ACCESS_DENIED)
                    throw new ShepPipeRefusal("REFUSED", "another process is already serving this private operator pipe");
                throw new ShepPipeRefusal("UNSAFE", "cannot create the private operator pipe (error " + error + ")");
            }
        }
        finally
        {
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            ShepWin.LocalFree(raw);
        }
        try
        {
            if (GetFileType(handle) != FILE_TYPE_PIPE)
                throw new ShepPipeRefusal("UNSAFE", "the private operator endpoint is not a named pipe");
            AssertDescriptor(PipeSecurityBytes(handle), CurrentUserSid());
            IntPtr self;
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out self))
                throw new ShepPipeRefusal("UNAVAILABLE", "cannot read this process's user token (error " + Marshal.GetLastWin32Error() + ")");
            try { AssertPlainUser(self, "this Shepherdr process"); }
            finally { ShepWin.CloseHandle(self); }
            WatchParent(parentPid);
            return handle;
        }
        catch (Exception)
        {
            ShepWin.CloseHandle(handle);
            throw;
        }
    }

    // A helper whose application is gone must not keep serving: stdin may be inherited and stay open after the parent
    // dies, so the operator loop itself cannot rely on EOF. Exit here rather than waiting for a client that will never
    // come.
    public static void WatchParent(int parentPid)
    {
        if (parentPid <= 0)
            throw new ShepPipeRefusal("UNSAFE", "the private operator needs the process it belongs to");
        IntPtr parent = OpenProcess(PROCESS_SYNCHRONIZE, false, unchecked((uint)parentPid));
        if (parent == IntPtr.Zero)
            throw new ShepPipeRefusal("UNAVAILABLE", "parent process " + parentPid + " is gone or cannot be watched");
        Thread watch = new Thread(delegate()
        {
            WaitForSingleObject(parent, 0xFFFFFFFF);
            Environment.Exit(0);
        });
        watch.IsBackground = true;
        watch.Start();
    }

    public static void OperatorAccept(IntPtr pipe)
    {
        if (ConnectNamedPipe(pipe, IntPtr.Zero)) return;
        int error = Marshal.GetLastWin32Error();
        if (error == ERROR_PIPE_CONNECTED) return;
        throw new ShepPipeRefusal("UNAVAILABLE", "cannot accept a private operator connection (error " + error + ")");
    }

    // The identity check uses the connected pipe itself: the client process id is read from this handle, its token must
    // be this account in this session at medium integrity, and the id is read again afterwards so a reused handle cannot
    // pass itself off as another process.
    public static uint OperatorPeer(IntPtr pipe)
    {
        uint pid;
        if (!GetNamedPipeClientProcessId(pipe, out pid) || pid == 0)
            throw new ShepPipeRefusal("UNAVAILABLE", "this Windows version cannot report the operator client process; Shepherdr refuses a pipe it cannot verify");
        string currentSid = CurrentUserSid();
        uint currentSession = CurrentSession();
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero)
            throw new ShepPipeRefusal("UNSAFE", "cannot open the operator client process (error " + Marshal.GetLastWin32Error() + ")");
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out token))
                throw new ShepPipeRefusal("UNSAFE", "cannot read the operator client's token (error " + Marshal.GetLastWin32Error() + ")");
            string sid = TokenSid(token);
            uint session = TokenSession(token);
            AssertPlainUser(token, "the operator client");
            uint second;
            if (!GetNamedPipeClientProcessId(pipe, out second) || second != pid)
                throw new ShepPipeRefusal("UNSAFE", "the operator client process changed while it was being verified");
            if (sid != currentSid || session != currentSession)
                throw new ShepPipeRefusal("UNSAFE", "the operator client is from a different account or Windows session");
            return pid;
        }
        finally
        {
            if (token != IntPtr.Zero) ShepWin.CloseHandle(token);
            ShepWin.CloseHandle(process);
        }
    }

    public static byte[] OperatorRead(IntPtr pipe, int max, int deadlineMs)
    {
        int deadline = unchecked(Environment.TickCount + deadlineMs);
        byte[] header = OperatorReadExact(pipe, 4, deadline, "the operator client sent no complete frame in time");
        int length = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
        if (length < 1)
            throw new ShepPipeRefusal("UNSAFE", "the operator client sent an empty frame");
        if (length > max)
            throw new ShepPipeRefusal("UNSAFE", "the operator frame is larger than " + max + " bytes");
        return OperatorReadExact(pipe, length, deadline, "the operator client stopped in the middle of a frame");
    }

    // One absolute deadline covers header and body: a peer that trickles a byte at a time cannot extend the window.
    static byte[] OperatorReadExact(IntPtr pipe, int count, int deadline, string timeout)
    {
        byte[] buffer = new byte[count];
        int got = 0;
        while (got < count)
        {
            int remaining = deadline - unchecked(Environment.TickCount);
            if (remaining <= 0)
                throw new ShepPipeRefusal("TIMEOUT", timeout);
            uint available;
            if (!PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)
                    throw new ShepPipeRefusal("UNAVAILABLE", "the operator client closed the pipe before its frame was complete");
                throw new ShepPipeRefusal("UNAVAILABLE", "cannot read the operator pipe (error " + error + ")");
            }
            if (available == 0)
            {
                Thread.Sleep(20);
                continue;
            }
            int want = Math.Min(count - got, (int)available);
            byte[] chunk = new byte[want];
            uint read;
            if (!ShepWin.ReadFile(pipe, chunk, (uint)want, out read, IntPtr.Zero) || read == 0)
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)
                    throw new ShepPipeRefusal("UNAVAILABLE", "the operator client closed the pipe before its frame was complete");
                throw new ShepPipeRefusal("UNAVAILABLE", "cannot read the operator pipe (error " + error + ")");
            }
            Array.Copy(chunk, 0, buffer, got, (int)read);
            got += (int)read;
        }
        return buffer;
    }

    // A connected peer that never reads would block a synchronous WriteFile forever and pin the only server. The write
    // runs on a background thread with an absolute deadline. A peer that misses it ends this helper process: closing the
    // handle from here would race the still-running WriteFile and leave a reused handle behind, and this helper has no
    // other work to do. Process exit is what reliably cancels the pending I/O; the message carries no secret.
    public static void OperatorWrite(IntPtr pipe, byte[] payload)
    {
        byte[] frame = new byte[payload.Length + 4];
        frame[0] = (byte)(payload.Length & 0xFF);
        frame[1] = (byte)((payload.Length >> 8) & 0xFF);
        frame[2] = (byte)((payload.Length >> 16) & 0xFF);
        frame[3] = (byte)((payload.Length >> 24) & 0xFF);
        Array.Copy(payload, 0, frame, 4, payload.Length);
        Exception failure = null;
        Thread writer = new Thread(delegate()
        {
            try
            {
                int sent = 0;
                while (sent < frame.Length)
                {
                    byte[] chunk = new byte[frame.Length - sent];
                    Array.Copy(frame, sent, chunk, 0, chunk.Length);
                    uint wrote;
                    if (!ShepWin.WriteFile(pipe, chunk, (uint)chunk.Length, out wrote, IntPtr.Zero) || wrote == 0)
                        throw new ShepPipeRefusal("UNAVAILABLE", "cannot write the operator reply (error " + Marshal.GetLastWin32Error() + ")");
                    sent += (int)wrote;
                }
            }
            catch (Exception e) { failure = e; }
        });
        writer.IsBackground = true;
        writer.Start();
        if (!writer.Join(OperatorWriteMs))
        {
            Console.Error.WriteLine("shepherdr-operator TIMEOUT: the operator client did not read its reply in time");
            Console.Error.Flush();
            Environment.Exit(3);
            throw new ShepPipeRefusal("TIMEOUT", "the operator client did not read its reply in time");
        }
        if (failure != null)
        {
            ShepPipeRefusal refusal = failure as ShepPipeRefusal;
            if (refusal != null) throw refusal;
            throw new ShepPipeRefusal("UNAVAILABLE", "cannot write the operator reply: " + failure.Message);
        }
    }

    public static void OperatorDisconnect(IntPtr pipe)
    {
        try { DisconnectNamedPipe(pipe); } catch (Exception) { }
    }

    public static void OperatorClose(IntPtr pipe)
    {
        if (pipe == IntPtr.Zero) return;
        try { ShepWin.CloseHandle(pipe); } catch (Exception) { }
    }

    public static int OperatorPid()
    {
        return System.Diagnostics.Process.GetCurrentProcess().Id;
    }

    // The same 4-byte little-endian length and UTF-8 payload framing is used on the client pipe and on the helper's own
    // stdin/stdout channel; the app channel adds one tag byte so the application can tell a request from the helper's
    // "the client already received this reply" acknowledgement without re-encoding any JSON.
    public static byte[] FrameRead(Stream stream, int max, int deadlineMs, string timeout)
    {
        int deadline = unchecked(Environment.TickCount + deadlineMs);
        byte[] header = FrameReadExact(stream, 4, deadline, timeout);
        int length = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
        if (length < 1)
            throw new ShepPipeRefusal("UNSAFE", "an operator frame was empty");
        if (length > max)
            throw new ShepPipeRefusal("UNSAFE", "an operator frame is larger than " + max + " bytes");
        return FrameReadExact(stream, length, deadline, timeout);
    }

    public static byte[] FrameReadTagged(Stream stream, int max, int deadlineMs, string timeout, out byte tag)
    {
        byte[] frame = FrameRead(stream, max, deadlineMs, timeout);
        tag = frame[0];
        byte[] body = new byte[frame.Length - 1];
        Array.Copy(frame, 1, body, 0, body.Length);
        return body;
    }

    static byte[] FrameReadExact(Stream stream, int count, int deadline, string timeout)
    {
        byte[] buffer = new byte[count];
        int got = 0;
        while (got < count)
        {
            int remaining = deadline - unchecked(Environment.TickCount);
            if (remaining <= 0)
                throw new ShepPipeRefusal("TIMEOUT", timeout);
            Task<int> read = stream.ReadAsync(buffer, got, count - got);
            try
            {
                if (!read.Wait(remaining))
                    throw new ShepPipeRefusal("TIMEOUT", timeout);
            }
            catch (AggregateException e)
            {
                throw new ShepPipeRefusal("UNAVAILABLE", "cannot read the operator pipe: " + e.InnerException.Message);
            }
            int value = read.Result;
            if (value <= 0)
                throw new ShepPipeRefusal("UNAVAILABLE", "the operator pipe closed before a frame was complete");
            got += value;
        }
        return buffer;
    }

    public static void FrameWrite(Stream stream, byte[] payload)
    {
        byte[] frame = new byte[payload.Length + 4];
        frame[0] = (byte)(payload.Length & 0xFF);
        frame[1] = (byte)((payload.Length >> 8) & 0xFF);
        frame[2] = (byte)((payload.Length >> 16) & 0xFF);
        frame[3] = (byte)((payload.Length >> 24) & 0xFF);
        Array.Copy(payload, 0, frame, 4, payload.Length);
        stream.Write(frame, 0, frame.Length);
        stream.Flush();
    }

    public static void FrameWriteTagged(Stream stream, byte tag, byte[] body)
    {
        byte[] payload = new byte[body.Length + 1];
        payload[0] = tag;
        Array.Copy(body, 0, payload, 1, body.Length);
        FrameWrite(stream, payload);
    }

    // The client half: the same owner/DACL/server-token verification as the core pipe, on the connected handle that is
    // about to carry the frames, plus the helper pid this core instance published. A different server process on the
    // same name is refused before any handshake or secret.
    public static void VerifyClient(NamedPipeClientStream pipe, string pipePath, int expectedPid)
    {
        Verify(pipe, pipePath);
        uint server;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out server) || server == 0)
            throw new ShepPipeRefusal("UNAVAILABLE", "this Windows version cannot report the operator's process");
        if (server != (uint)expectedPid)
            throw new ShepPipeRefusal("REFUSED", "the private operator is not the helper this core instance published");
    }

    public static int RefuseOperator(string code, string message)
    {
        string text = message == null ? "refused" : message.Replace("\r", " ").Replace("\n", " ");
        if (text.Length > 500) text = text.Substring(0, 500);
        Console.Error.WriteLine("shepherdr-operator " + code + ": " + text);
        Console.Error.Flush();
        return code == "TIMEOUT" ? 3 : code == "UNAVAILABLE" ? 6 : 4;
    }
}
'@

class ShepError : System.Exception {
  [string]$Code
  ShepError([string]$code, [string]$message) : base($message) { $this.Code = $code }
}

$trustedOwners = @(
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
# Ancestors: rights that let another account remove or replace the child, or take the ancestor over. FILE_ADD_FILE /
# FILE_ADD_SUBDIRECTORY are deliberately absent: creating a differently named sibling cannot replace an existing child,
# and a same-named create races our CREATE_NEW, which then verifies (and refuses) the pre-created object. Stock Windows
# grants Authenticated Users (AD) on the volume root, so treating it as a takeover right would refuse every home.
$dangerMask = [uint32]0x100D0040
$fullControl = [uint32]0x1F01FF

function Get-ShepError($record) {
  $e = $record.Exception
  while ($null -ne $e) {
    if ($e -is [ShepError]) { return $e }
    $e = $e.InnerException
  }
  return $null
}

function Get-PipeRefusal($record) {
  $e = $record.Exception
  while ($null -ne $e) {
    if ($e -is [ShepPipeRefusal]) { return $e }
    $e = $e.InnerException
  }
  return $null
}

function Get-Win32Code($record) {
  $e = $record.Exception
  while ($null -ne $e) {
    if ($e -is [System.ComponentModel.Win32Exception]) { return [int]$e.NativeErrorCode }
    $e = $e.InnerException
  }
  return 0
}

function Map-Code([int]$native) {
  if ($native -eq 2 -or $native -eq 3) { return 'ENOENT' }
  if ($native -eq 5) { return 'EACCES' }
  if ($native -eq 32 -or $native -eq 33) { return 'SHARING' }
  if ($native -eq 80 -or $native -eq 183) { return 'EEXIST' }
  if ($native -eq 267) { return 'ENOTDIR' }
  if ($native -eq 1314) { return 'EPERM' }
  return 'UNSAFE'
}

function Get-LongPath([string]$path) {
  return [ShepWin]::LongPath($path)
}

function Normalize-FinalPath([string]$path) {
  if ($path.StartsWith('\\?\UNC\')) {
    throw [ShepError]::new('UNSAFE', 'network shares are not private state')
  }
  if ($path.StartsWith('\\?\')) { $path = $path.Substring(4) }
  if ($path -notmatch '^[A-Za-z]:\\') {
    throw [ShepError]::new('UNSAFE', 'object does not resolve to a local drive path')
  }
  $trimmed = $path.TrimEnd('\')
  if ($trimmed.Length -eq 2 -and $trimmed[1] -eq ':') { return $trimmed + '\' }
  return $trimmed
}

function Test-SamePath([string]$final, [string]$expected) {
  $a = Normalize-FinalPath $final
  $b = Normalize-FinalPath (Get-LongPath $expected)
  return [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-Path([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { throw [ShepError]::new('UNSAFE', 'path is empty') }
  if ($path.StartsWith('\\')) { throw [ShepError]::new('UNSAFE', 'network, device and UNC paths are not private state') }
  if ($path -notmatch '^[A-Za-z]:[\\/]') { throw [ShepError]::new('UNSAFE', 'path must be an absolute drive path') }
  # Check the raw text first: GetFullPath silently strips a trailing dot or space and rejects a stream suffix, so a
  # post-normalization check would let C:\repo\data.bin. read C:\repo\data.bin instead of refusing the alias.
  if ($path.Substring(2).Contains(':')) { throw [ShepError]::new('UNSAFE', 'alternate data streams are not allowed') }
  foreach ($raw in $path.Split([char[]]@('\', '/'))) {
    if ([string]::IsNullOrEmpty($raw) -or $raw -eq '.' -or $raw -eq '..') { continue }
    if ($raw.EndsWith('.') -or $raw.EndsWith(' ')) {
      throw [ShepError]::new('UNSAFE', 'trailing dots and spaces are not allowed in a private path')
    }
  }
  $full = [System.IO.Path]::GetFullPath($path)
  if ($full -notmatch '^[A-Za-z]:\\') { throw [ShepError]::new('UNSAFE', 'path must be an absolute drive path') }
  if ($full.Substring(2).Contains(':')) { throw [ShepError]::new('UNSAFE', 'alternate data streams are not allowed') }
  # Windows also reserves COM and LPT followed by a superscript 1, 2 or 3 (U+00B9, U+00B2, U+00B3). They are built
  # from code points so this script stays ASCII: PowerShell 5.1 reads a BOM-less file in the system codepage, not UTF-8.
  $superscript = [string][char]0x00b9 + [char]0x00b2 + [char]0x00b3
  foreach ($part in $full.Substring(3).Split('\')) {
    if ([string]::IsNullOrEmpty($part)) { continue }
    if ($part.EndsWith('.') -or $part.EndsWith(' ')) {
      throw [ShepError]::new('UNSAFE', 'trailing dots and spaces are not allowed in a private path')
    }
    if ($part -match "^(CON|PRN|AUX|NUL|COM[1-9$superscript]|LPT[1-9$superscript])(\..*)?$") {
      throw [ShepError]::new('UNSAFE', 'reserved device names are not allowed in a private path')
    }
  }
  $root = $full.Substring(0, 3)
  if ([ShepWin]::GetDriveTypeW($root) -ne [ShepWin]::DRIVE_FIXED) {
    throw [ShepError]::new('UNSAFE', 'private state must be on a local fixed volume')
  }
  return $full
}

function Get-Parent([string]$path) {
  $parent = [System.IO.Path]::GetDirectoryName($path)
  if ([string]::IsNullOrEmpty($parent) -or $parent -eq $path) { return $null }
  return $parent
}

function Close-Handles($handles) {
  if ($null -eq $handles) { return }
  foreach ($h in $handles) { [ShepWin]::CloseHandle($h) | Out-Null }
}

function Close-Chain($chain) {
  if ($null -eq $chain) { return }
  Close-Handles $chain.Handles
}

function Close-Context($context) {
  if ($null -eq $context) { return }
  if ($null -ne $context.Handle) { [ShepWin]::CloseHandle($context.Handle) | Out-Null }
  Close-Chain $context.Chain
}

function Assert-Descriptor($raw, [string]$currentSid, [string]$label, [bool]$ancestor) {
  if ($null -eq $raw.Owner -or [string]::IsNullOrEmpty($raw.Owner.Value)) {
    throw [ShepError]::new('UNSAFE', "$label has no verifiable owner")
  }
  $owner = $raw.Owner.Value
  if ($ancestor) {
    if ($owner -ne $currentSid -and $trustedOwners -notcontains $owner) {
      throw [ShepError]::new('UNSAFE', "$label is owned by another account that could replace it")
    }
  } elseif ($owner -ne $currentSid) {
    throw [ShepError]::new('UNSAFE', "$label must be owned by you")
  }
  if ($null -eq $raw.DiscretionaryAcl) { throw [ShepError]::new('UNSAFE', "$label has no DACL") }
  $hasFull = $false
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -isnot [System.Security.AccessControl.KnownAce]) {
      throw [ShepError]::new('UNSAFE', "$label has an ACE that cannot be verified")
    }
    $type = $ace.AceType
    $allow = $type -eq [System.Security.AccessControl.AceType]::AccessAllowed -or $type -eq [System.Security.AccessControl.AceType]::AccessAllowedObject
    $deny = $type -eq [System.Security.AccessControl.AceType]::AccessDenied -or $type -eq [System.Security.AccessControl.AceType]::AccessDeniedObject
    if (-not $allow -and -not $deny) {
      throw [ShepError]::new('UNSAFE', "$label has an ACE type that cannot be verified")
    }
    # AceFlags is a Byte-backed enum; Windows PowerShell 5.1 cannot band an enum operand directly.
    $inheritOnly = (([int]$ace.AceFlags -band [int][System.Security.AccessControl.AceFlags]::InheritOnly) -ne 0)
    # An ancestor's inherit-only ACEs do not apply to the ancestor itself and our private objects carry a protected DACL,
    # so they cannot widen the object being verified. A private object's inherit-only ACEs still apply to children it
    # does not control (SQLite's journal, for example), so its trustee and deny checks must see them; they just cannot
    # satisfy the current SID's full-control requirement.
    if ($ancestor -and $inheritOnly) { continue }
    $sid = $ace.SecurityIdentifier.Value
    $mask = [uint32]$ace.AccessMask
    if ($ancestor) {
      if ($deny) { continue }
      if ($sid -eq $currentSid -or $trustedOwners -contains $sid) { continue }
      if (($mask -band $dangerMask) -ne 0) {
        throw [ShepError]::new('UNSAFE', "$label grants another account write, delete or replace rights")
      }
      continue
    }
    if ($deny) {
      throw [ShepError]::new('UNSAFE', "$label has a deny ACE; a denial cannot make a loose DACL private")
    }
    if ($sid -ne $currentSid -and $sid -ne 'S-1-5-18') {
      throw [ShepError]::new('UNSAFE', "$label grants access to another account")
    }
    if (-not $inheritOnly -and $sid -eq $currentSid -and ((($mask -band $fullControl) -eq $fullControl) -or (($mask -band [uint32]0x10000000) -ne 0))) {
      $hasFull = $true
    }
  }
  if (-not $ancestor -and -not $hasFull) {
    throw [ShepError]::new('UNSAFE', "$label does not grant you full control")
  }
}

function Read-HandleInfo($handle) {
  $attributes = [uint32]0
  $links = [uint32]0
  $identity = ''
  $size = [uint64]0
  [ShepWin]::Info($handle, [ref]$attributes, [ref]$links, [ref]$identity, [ref]$size)
  return @{ Attributes = [uint32]$attributes; Links = [uint32]$links; Identity = $identity; Size = [uint64]$size }
}

function Assert-DirectoryHandle($handle, [string]$path, [string]$currentSid, [bool]$ancestor) {
  $info = Read-HandleInfo $handle
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
    throw [ShepError]::new('UNSAFE', "$path is a reparse point, not a real directory")
  }
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_DIRECTORY) -eq 0) {
    throw [ShepError]::new('ENOTDIR', "$path is not a directory")
  }
  if (-not (Test-SamePath ([ShepWin]::FinalPath($handle)) $path)) {
    throw [ShepError]::new('UNSAFE', "$path resolved to a different object")
  }
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new([ShepWin]::SecurityBytes($handle), 0)
  $label = if ($ancestor) { "parent directory $path" } else { $path }
  Assert-Descriptor $raw $currentSid $label $ancestor
  return $info
}

# Open and verify every ancestor from the drive root down, keeping each handle open without FILE_SHARE_DELETE. While
# these handles live, no ancestor can be renamed, deleted or replaced, so the path used for the child stays the one that
# was verified.
function Open-Chain([string]$path, [string]$currentSid) {
  $directories = New-Object System.Collections.ArrayList
  $parent = Get-Parent $path
  while ($null -ne $parent) {
    [void]$directories.Insert(0, $parent)
    $parent = Get-Parent $parent
  }
  $handles = New-Object System.Collections.ArrayList
  try {
    foreach ($directory in $directories) {
      $handle = [ShepWin]::OpenForRead($directory, $true)
      [void]$handles.Add($handle)
      Assert-DirectoryHandle $handle $directory $currentSid $true | Out-Null
    }
    $parentHandle = if ($handles.Count -gt 0) { $handles[$handles.Count - 1] } else { [IntPtr]::Zero }
    return @{ Handles = $handles; Parent = $parentHandle }
  } catch {
    Close-Handles $handles
    throw
  }
}

function Assert-PrivateDirectoryHandle($handle, [string]$path, [string]$currentSid) {
  $info = Read-HandleInfo $handle
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
    throw [ShepError]::new('UNSAFE', 'Shepherdr home must be a real directory, not a reparse point')
  }
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_DIRECTORY) -eq 0) {
    throw [ShepError]::new('ENOTDIR', 'Shepherdr home must be a real directory')
  }
  if (-not (Test-SamePath ([ShepWin]::FinalPath($handle)) $path)) {
    throw [ShepError]::new('UNSAFE', 'Shepherdr home resolved to a different object')
  }
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new([ShepWin]::SecurityBytes($handle), 0)
  Assert-Descriptor $raw $currentSid 'Shepherdr home' $false
  return $info
}

function Assert-PrivateDirectory([string]$path) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $full = Assert-Path $path
  $chain = Open-Chain $full $currentSid
  $handle = [IntPtr]::Zero
  try {
    $handle = [ShepWin]::OpenForRead($full, $true)
    Assert-PrivateDirectoryHandle $handle $full $currentSid | Out-Null
  } finally {
    if ($handle -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($handle) | Out-Null }
    Close-Chain $chain
  }
}

function New-PrivateDirectory([string]$path) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $full = Assert-Path $path
  $chain = Open-Chain $full $currentSid
  $handle = [IntPtr]::Zero
  try {
    $sddl = "O:$currentSid" + "D:P(A;OICI;FA;;;$currentSid)(A;OICI;FA;;;SY)"
    [ShepWin]::CreateDirectoryPrivate($full, $sddl)
    $handle = [ShepWin]::OpenForRead($full, $true)
    Assert-PrivateDirectoryHandle $handle $full $currentSid | Out-Null
  } finally {
    if ($handle -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($handle) | Out-Null }
    Close-Chain $chain
  }
}

function Assert-PrivateFileHandle($handle, [string]$path, [string]$currentSid) {
  $info = Read-HandleInfo $handle
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
    throw [ShepError]::new('UNSAFE', 'Private file must not be a link or reparse point')
  }
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_DIRECTORY) -ne 0) {
    throw [ShepError]::new('ENOTDIR', 'Private file must be a regular file')
  }
  if ($info.Links -ne 1) {
    throw [ShepError]::new('UNSAFE', 'Private file must have a single link')
  }
  if (-not (Test-SamePath ([ShepWin]::FinalPath($handle)) $path)) {
    throw [ShepError]::new('UNSAFE', 'Private file resolved to a different object')
  }
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new([ShepWin]::SecurityBytes($handle), 0)
  Assert-Descriptor $raw $currentSid 'Private file' $false
  return $info
}

# Leave the parent chain open (no delete sharing) so the verified parent cannot be swapped before the child is opened.
function Open-PrivateFile([string]$path) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $full = Assert-Path $path
  $chain = Open-Chain $full $currentSid
  $handle = [IntPtr]::Zero
  try {
    $handle = [ShepWin]::OpenForRead($full, $false)
    $info = Assert-PrivateFileHandle $handle $full $currentSid
    return @{ Handle = $handle; Chain = $chain; Info = $info; Full = $full }
  } catch {
    if ($handle -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($handle) | Out-Null }
    Close-Chain $chain
    throw
  }
}

function Read-PrivateFile([string]$path, [int]$max) {
  if ($max -le 0 -or $max -gt 33554432) {
    throw [ShepError]::new('TOOLARGE', 'file read limit must be between 1 and 33554432 bytes')
  }
  $context = Open-PrivateFile $path
  try {
    if ($context.Info.Size -gt [uint64]$max) {
      throw [ShepError]::new('TOOLARGE', 'file is larger than the configured limit')
    }
    $bytes = [ShepWin]::ReadAll($context.Handle, [int]$context.Info.Size)
    $after = Read-HandleInfo $context.Handle
    if ($after.Identity -ne $context.Info.Identity -or $after.Links -ne 1 -or $after.Size -ne $context.Info.Size) {
      throw [ShepError]::new('UNSAFE', 'file changed while being read')
    }
    return [Convert]::ToBase64String($bytes)
  } finally { Close-Context $context }
}

# Test seam: holds the exact production chain and file handles, announces readiness, waits for an explicit continue,
# then re-verifies the same handle. It reads no content, runs no caller command and grants nothing; the wait is bounded.
function Hold-PrivateFile([string]$path, [int]$waitMs) {
  if ($waitMs -le 0) { $waitMs = 60000 }
  if ($waitMs -gt 120000) { $waitMs = 120000 }
  $context = Open-PrivateFile $path
  try {
    $before = $context.Info
    [Console]::Out.WriteLine((@{ ok = $true; ready = $true; identity = $before.Identity; size = $before.Size } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $line = [Console]::In.ReadLineAsync()
    if (-not $line.Wait($waitMs)) { throw [ShepError]::new('UNAVAILABLE', 'hold timed out waiting for continue') }
    if ($null -eq $line.Result -or $line.Result.Trim() -ne 'continue') {
      throw [ShepError]::new('UNSAFE', 'hold was cancelled')
    }
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $checked = Assert-PrivateFileHandle $context.Handle $context.Full $currentSid
    if ($checked.Identity -ne $before.Identity -or $checked.Size -ne $before.Size) {
      throw [ShepError]::new('UNSAFE', 'held file changed during the hold')
    }
    return @{ identity = $checked.Identity; size = $checked.Size }
  } finally { Close-Context $context }
}

function Verify-PrivateFile([string]$path) {
  $context = Open-PrivateFile $path
  try {
    return @{ identity = $context.Info.Identity; size = $context.Info.Size }
  } finally { Close-Context $context }
}

function Write-PrivateFile([string]$path, [byte[]]$data, [bool]$exclusive) {
  if ($data.Length -gt 33554432) {
    throw [ShepError]::new('TOOLARGE', 'file is larger than the 33554432-byte limit')
  }
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $full = Assert-Path $path
  $chain = Open-Chain $full $currentSid
  $existing = [IntPtr]::Zero
  $temporary = [IntPtr]::Zero
  $temporaryPath = $null
  $published = $false
  try {
    $exists = $false
    try {
      $existing = [ShepWin]::OpenForRead($full, $false)
      Assert-PrivateFileHandle $existing $full $currentSid | Out-Null
      $exists = $true
    } catch {
      $shep = Get-ShepError $_
      $native = Get-Win32Code $_
      if ($null -eq $shep -and ($native -eq 2 -or $native -eq 3)) {
        $exists = $false
      } else {
        throw
      }
    }
    if ($exists -and $exclusive) { throw [ShepError]::new('EEXIST', 'file already exists') }
    # Close the validated existing file before the replace rename: a share-read handle would block deletion of the old name.
    if ($existing -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($existing) | Out-Null; $existing = [IntPtr]::Zero }

    $parentPath = Get-Parent $full
    if ([string]::IsNullOrEmpty($parentPath) -or $chain.Parent -eq [IntPtr]::Zero) {
      throw [ShepError]::new('UNSAFE', 'file needs a verified parent directory')
    }
    $leaf = [System.IO.Path]::GetFileName($full)
    $temporaryPath = Assert-Path ([System.IO.Path]::Combine($parentPath, '.shep-' + [guid]::NewGuid().ToString('N') + '.tmp'))
    $sddl = "O:$currentSid" + "D:P(A;;FA;;;$currentSid)(A;;FA;;;SY)"
    $temporary = [ShepWin]::CreateFilePrivate($temporaryPath, $sddl)
    try {
      [ShepWin]::WriteAll($temporary, $data)
      Assert-PrivateFileHandle $temporary $temporaryPath $currentSid | Out-Null
      # Publish by handle relative to the verified parent handle; no path is resolved again.
      [ShepWin]::Rename($temporary, $chain.Parent, $leaf, $exists)
      $published = $true
      Assert-PrivateFileHandle $temporary $full $currentSid | Out-Null
    } finally {
      [ShepWin]::CloseHandle($temporary) | Out-Null
      $temporary = [IntPtr]::Zero
      if (-not $published -and $null -ne $temporaryPath) {
        try { [System.IO.File]::Delete($temporaryPath) } catch {}
      }
    }
  } finally {
    if ($existing -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($existing) | Out-Null }
    if ($temporary -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($temporary) | Out-Null }
    Close-Chain $chain
  }
}

# An ordinary repository file is not private state: its DACL and owner are not ours to demand. Everything else still
# holds - every ancestor is a real directory (no reparse point) held open without delete sharing, and the leaf is one
# regular file with a single link read from that same handle.
function Assert-PlainDirectoryHandle($handle, [string]$path) {
  $info = Read-HandleInfo $handle
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
    throw [ShepError]::new('UNSAFE', "$path is a reparse point, not a real directory")
  }
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_DIRECTORY) -eq 0) {
    throw [ShepError]::new('ENOTDIR', "$path is not a directory")
  }
  if (-not (Test-SamePath ([ShepWin]::FinalPath($handle)) $path)) {
    throw [ShepError]::new('UNSAFE', "$path resolved to a different object")
  }
  return $info
}

function Open-PlainChain([string]$path) {
  $directories = New-Object System.Collections.ArrayList
  $parent = Get-Parent $path
  while ($null -ne $parent) {
    [void]$directories.Insert(0, $parent)
    $parent = Get-Parent $parent
  }
  $handles = New-Object System.Collections.ArrayList
  try {
    foreach ($directory in $directories) {
      $handle = [ShepWin]::OpenForRead($directory, $true)
      [void]$handles.Add($handle)
      Assert-PlainDirectoryHandle $handle $directory | Out-Null
    }
    $parentHandle = if ($handles.Count -gt 0) { $handles[$handles.Count - 1] } else { [IntPtr]::Zero }
    return @{ Handles = $handles; Parent = $parentHandle }
  } catch {
    Close-Handles $handles
    throw
  }
}

function Assert-PlainFileHandle($handle, [string]$path) {
  $info = Read-HandleInfo $handle
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0) {
    throw [ShepError]::new('UNSAFE', "$path is a link or reparse point, not a real file")
  }
  if (($info.Attributes -band [ShepWin]::FILE_ATTRIBUTE_DIRECTORY) -ne 0) {
    throw [ShepError]::new('ENOTDIR', "$path is a directory, not a file")
  }
  if ($info.Links -ne 1) {
    throw [ShepError]::new('UNSAFE', "$path has more than one link")
  }
  if (-not (Test-SamePath ([ShepWin]::FinalPath($handle)) $path)) {
    throw [ShepError]::new('UNSAFE', "$path resolved to a different object")
  }
  return $info
}

function Open-PlainFile([string]$path) {
  $full = Assert-Path $path
  $chain = Open-PlainChain $full
  $handle = [IntPtr]::Zero
  try {
    $handle = [ShepWin]::OpenForRead($full, $false)
    $info = Assert-PlainFileHandle $handle $full
    return @{ Handle = $handle; Chain = $chain; Info = $info; Full = $full }
  } catch {
    if ($handle -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($handle) | Out-Null }
    Close-Chain $chain
    throw
  }
}

# The canonical path comes from the same held handle as the bytes: a caller that applies its own path policy to the
# answer is judging the object it actually received, not a name that may point somewhere else by now.
function Read-PlainFile([string]$path, [int]$max) {
  if ($max -le 0 -or $max -gt 33554432) {
    throw [ShepError]::new('TOOLARGE', 'file read limit must be between 1 and 33554432 bytes')
  }
  $context = Open-PlainFile $path
  try {
    if ($context.Info.Size -gt [uint64]$max) {
      throw [ShepError]::new('TOOLARGE', 'file is larger than the configured limit')
    }
    $bytes = [ShepWin]::ReadAll($context.Handle, [int]$context.Info.Size)
    $after = Read-HandleInfo $context.Handle
    if ($after.Identity -ne $context.Info.Identity -or $after.Links -ne 1 -or $after.Size -ne $context.Info.Size) {
      throw [ShepError]::new('UNSAFE', 'file changed while being read')
    }
    return @{ Data = [Convert]::ToBase64String($bytes); Path = (Normalize-FinalPath ([ShepWin]::FinalPath($context.Handle))) }
  } finally { Close-Context $context }
}

# The head of a file for a reader that shows a prefix instead of refusing a large file: the same plain ancestor chain,
# the same single handle and the same after-read identity check as Read-PlainFile, but the object may be larger than the
# read limit. Only the first $max bytes are ever allocated; the object's real length is reported beside them so the
# caller can say "too big" from the object it actually held, not from a second look at the name.
function Read-PlainFileHead([string]$path, [int]$max) {
  if ($max -le 0 -or $max -gt 1000000) {
    throw [ShepError]::new('TOOLARGE', 'file head limit must be between 1 and 1000000 bytes')
  }
  $context = Open-PlainFile $path
  try {
    if ($context.Info.Size -gt [uint64]9007199254740991) {
      throw [ShepError]::new('TOOLARGE', 'file is larger than this protocol can report exactly')
    }
    [uint64]$size = $context.Info.Size
    [int]$count = [int]$max
    if ($size -lt [uint64]$max) { $count = [int]$size }
    $bytes = [ShepWin]::ReadAll($context.Handle, $count)
    $after = Read-HandleInfo $context.Handle
    if ($after.Identity -ne $context.Info.Identity -or $after.Links -ne 1 -or $after.Size -ne $context.Info.Size) {
      throw [ShepError]::new('UNSAFE', 'file changed while being read')
    }
    return @{ Data = [Convert]::ToBase64String($bytes); Path = (Normalize-FinalPath ([ShepWin]::FinalPath($context.Handle))); Size = $size }
  } finally { Close-Context $context }
}

# A published name is one ordinary file name inside an already-verified directory. Everything a path could smuggle in
# (a separator, a stream, a drive, a device name, a trailing dot or space, a control character) is refused here, before
# any file is created, so a caller cannot turn a leaf into a second path.
function Assert-PlainLeaf([string]$leaf) {
  if ([string]::IsNullOrWhiteSpace($leaf)) { throw [ShepError]::new('UNSAFE', 'file name is empty') }
  if ($leaf -eq '.' -or $leaf -eq '..') { throw [ShepError]::new('UNSAFE', 'file name must not be . or ..') }
  if ($leaf.Length -gt 255) { throw [ShepError]::new('UNSAFE', 'file name is longer than 255 characters') }
  if ($leaf.IndexOfAny([char[]]@('\', '/', ':', '*', '?', '"', '<', '>', '|')) -ge 0) {
    throw [ShepError]::new('UNSAFE', 'file name must be a single plain Windows file name')
  }
  if ($leaf -match '[\u0000-\u001f\u007f]') {
    throw [ShepError]::new('UNSAFE', 'file name must not contain control characters')
  }
  if ($leaf.EndsWith('.') -or $leaf.EndsWith(' ')) {
    throw [ShepError]::new('UNSAFE', 'trailing dots and spaces are not allowed in a file name')
  }
  # COM and LPT followed by a superscript 1, 2 or 3 are reserved as well. The superscripts are built from code points
  # so this script stays ASCII: PowerShell 5.1 reads a BOM-less file in the system codepage, not UTF-8.
  $superscript = [string][char]0x00b9 + [char]0x00b2 + [char]0x00b3
  if ($leaf -match "^(CON|PRN|AUX|NUL|COM[1-9$superscript]|LPT[1-9$superscript])(\..*)?$") {
    throw [ShepError]::new('UNSAFE', 'reserved device names are not allowed in a file name')
  }
  return $leaf
}

# Publish one ordinary file into a checkout directory. The directory and every ancestor are held open without
# FILE_SHARE_DELETE and verified as real directories, so no rename or junction can redirect the name while this runs.
# The bytes go into a new uniquely named file that inherits the directory's own DACL (nothing is narrowed, nothing is
# granted beyond what the directory already carries), are flushed, and are checked on that same handle before the
# existing no-replace handle rename makes the name visible. A failure removes only the object this call created and
# still holds; it never deletes the target or any other name in the directory.
#
# Crash residue: a process killed between the create and the rename leaves one `.shep-<guid>.tmp` file in the directory.
# It is inert and carries the directory's own inherited DACL. This function never scans for or deletes such files, since
# it cannot prove it created them; cleanup of crash residue is the caller's/user's job, not a guess here.
function Publish-PlainFile([string]$directory, [string]$leaf, [byte[]]$data) {
  if ($data.Length -gt 16777216) {
    throw [ShepError]::new('TOOLARGE', 'file is larger than the 16777216-byte limit')
  }
  Assert-PlainLeaf $leaf | Out-Null
  $fullDirectory = Assert-Path $directory
  $target = [System.IO.Path]::Combine($fullDirectory, $leaf)
  # Ancestors root-first; the last held handle is the verified target directory itself, which is the rename root.
  $chain = Open-PlainChain $target
  $temporary = [IntPtr]::Zero
  $temporaryPath = $null
  $published = $false
  try {
    $attempt = 0
    while ($temporary -eq [IntPtr]::Zero) {
      $attempt++
      $candidate = [System.IO.Path]::Combine($fullDirectory, '.shep-' + [guid]::NewGuid().ToString('N') + '.tmp')
      try {
        $temporary = [ShepWin]::CreateFilePlain($candidate)
        $temporaryPath = $candidate
      } catch {
        $native = Get-Win32Code $_
        if ($native -eq 80 -or $native -eq 183) {
          if ($attempt -ge 4) { throw [ShepError]::new('EEXIST', 'could not create a unique temporary file') }
          $temporary = [IntPtr]::Zero
          continue
        }
        throw
      }
    }
    [ShepWin]::WriteAll($temporary, $data)
    [ShepWin]::Flush($temporary)
    $before = Assert-PlainFileHandle $temporary $temporaryPath
    if ($before.Size -ne [uint64]$data.Length) {
      throw [ShepError]::new('UNSAFE', 'temporary file does not hold the bytes that were written')
    }
    # Publish by handle relative to the verified directory handle; the name is never resolved again. A name that
    # appeared in the meantime makes the no-replace rename fail with EEXIST, so an existing file is never overwritten.
    [ShepWin]::Rename($temporary, $chain.Parent, $leaf, $false)
    # From here the name is visible, so a later failure must not delete it: it is the target now, not a temporary file.
    $published = $true
    $after = Assert-PlainFileHandle $temporary $target
    if ($after.Identity -ne $before.Identity -or $after.Size -ne $before.Size -or $after.Links -ne 1) {
      throw [ShepError]::new('UNSAFE', 'published file changed while being published')
    }
    return @{ identity = $after.Identity; size = $after.Size }
  } finally {
    if ($temporary -ne [IntPtr]::Zero) {
      if (-not $published) {
        # The deletion is issued on the handle this call created: a name swapped in meanwhile is not what disappears,
        # and the file goes away when the handle closes.
        try { [ShepWin]::Delete($temporary) } catch {}
      }
      [ShepWin]::CloseHandle($temporary) | Out-Null
    }
    Close-Chain $chain
  }
}

# Delete exactly the file whose handle passed the private-file checks. The path is not resolved again after those checks:
# the deletion is issued on the verified handle itself, so a name swapped in between is not what disappears.
function Delete-PrivateFile([string]$path) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $full = Assert-Path $path
  $chain = Open-Chain $full $currentSid
  $handle = [IntPtr]::Zero
  try {
    $handle = [ShepWin]::OpenForDelete($full)
    Assert-PrivateFileHandle $handle $full $currentSid | Out-Null
    [ShepWin]::Delete($handle)
  } finally {
    if ($handle -ne [IntPtr]::Zero) { [ShepWin]::CloseHandle($handle) | Out-Null }
    Close-Chain $chain
  }
}

# Pipe relay mode is dispatched before the JSON request path. After its control line, stdin is raw core bytes and must
# never be parsed as text; after READY, stdout is raw core bytes too. This mode grants nothing: the C# side opens,
# verifies and relays exactly one connection and returns an exit code.
if ($Operation -eq 'pipeClient') {
  $exitCode = 1
  try {
    $stdin = [Console]::OpenStandardInput()
    $bytes = New-Object System.Collections.Generic.List[byte]
    while ($true) {
      $one = $stdin.ReadByte()
      if ($one -lt 0) { throw [ShepError]::new('UNSAFE', 'pipe control line ended before a newline') }
      if ($one -eq 10) { break }
      if ($bytes.Count -ge 8192) { throw [ShepError]::new('TOOLARGE', 'pipe control line is too long') }
      $bytes.Add([byte]$one)
    }
    $request = [System.Text.Encoding]::UTF8.GetString($bytes.ToArray()) | ConvertFrom-Json
    if ($null -eq $request -or $request.operation -ne $Operation) { throw [ShepError]::new('UNSAFE', 'operation mismatch') }
    $full = [string]$request.pipe
    $prefix = '\\.\pipe\'
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw [ShepError]::new('UNSAFE', 'core endpoint must be a local named pipe: \\.\pipe\NAME')
    }
    $name = $full.Substring($prefix.Length)
    if ($name.Length -eq 0 -or $name -eq '.' -or $name -eq '..' -or $name -match '[\\/\u0000-\u001f\u007f]') {
      throw [ShepError]::new('UNSAFE', 'core pipe name is not a single local pipe leaf')
    }
    $exitCode = [ShepPipe]::Run($stdin, $full, $name, [int]$request.connectMs, [int]$request.parentPid)
  } catch {
    $message = $_.Exception.Message
    if ($message.Length -gt 300) { $message = $message.Substring(0, 300) }
    [Console]::Error.WriteLine('shepherdr-core-pipe UNSAFE: ' + $message.Replace("`r", ' ').Replace("`n", ' '))
  }
  exit $exitCode
}

# Reads one bounded control line from a raw stream, byte by byte, so the framed bytes that follow it are never eaten by
# a text reader's buffer.
function Read-ControlLine($stream, [int]$limit) {
  $bytes = New-Object System.Collections.Generic.List[byte]
  while ($true) {
    $one = $stream.ReadByte()
    if ($one -lt 0) { throw [ShepError]::new('UNSAFE', 'control line ended before a newline') }
    if ($one -eq 10) { break }
    if ($bytes.Count -ge $limit) { throw [ShepError]::new('TOOLARGE', 'control line is too long') }
    $bytes.Add([byte]$one)
  }
  return [System.Text.Encoding]::UTF8.GetString($bytes.ToArray())
}

# Local pipe name for both operator modes: the same shape the config layer accepts, and a leaf that cannot escape the
# pipe namespace.
function Get-OperatorPipe([string]$full, [string]$what) {
  $prefix = '\\.\pipe\'
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw [ShepError]::new('UNSAFE', $what + ' must be a local named pipe: \\.\pipe\NAME')
  }
  $name = $full.Substring($prefix.Length)
  if ($name.Length -eq 0 -or $name -eq '.' -or $name -eq '..' -or $name -match '[\\/\u0000-\u001f\u007f]') {
    throw [ShepError]::new('UNSAFE', $what + ' name is not a single local pipe leaf')
  }
  return $name
}

function Format-OperatorReply([string]$message, [int]$code) {
  return (@{ out = $message; code = $code } | ConvertTo-Json -Compress)
}

# Private operator server. The helper creates the pipe with a protected current-user/SYSTEM DACL, holds that exact
# handle, verifies every connected client's account, session and integrity, and relays bounded frames to the
# application. A client must pass the boot/pid handshake before its request bytes reach the secret handler.
if ($Operation -eq 'operatorServer') {
  $exitCode = 1
  $handle = [IntPtr]::Zero
  try {
    $stdin = [Console]::OpenStandardInput()
    $stdout = [Console]::OpenStandardOutput()
    $control = Read-ControlLine $stdin 8192 | ConvertFrom-Json
    if ($null -eq $control -or $control.operation -ne $Operation) { throw [ShepError]::new('UNSAFE', 'operation mismatch') }
    $boot = [string]$control.boot
    if ($boot -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
      throw [ShepError]::new('UNSAFE', 'the operator boot identity is not a boot id')
    }
    $full = [string]$control.pipe
    [void](Get-OperatorPipe $full 'the private operator endpoint')
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sddl = 'O:' + $sid + 'D:P(A;;0x001F01FF;;;' + $sid + ')(A;;0x001F01FF;;;SY)'
    $handle = [ShepPipe]::OperatorCreate($full, $sddl, [int]$control.parentPid)
    $ready = [System.Text.Encoding]::ASCII.GetBytes('SHEPHERDR-OPERATOR/1 ' + [ShepPipe]::OperatorPid() + "`n")
    $stdout.Write($ready, 0, $ready.Length)
    $stdout.Flush()
    $exitCode = 0
    $self = [int64][ShepPipe]::OperatorPid()
    while ($true) {
      [ShepPipe]::OperatorAccept($handle)
      $greeted = $false
      $fatal = $false
      try {
        $clientPid = [int64][ShepPipe]::OperatorPeer($handle)
        $helloText = [System.Text.Encoding]::UTF8.GetString([ShepPipe]::OperatorRead($handle, 4096, 5000))
        $hello = $helloText | ConvertFrom-Json
        if ($null -eq $hello -or -not ($hello.boot -is [string]) -or $hello.boot -ne $boot -or
          [int64]$hello.helperPid -ne $self -or [int64]$hello.pid -ne $clientPid -or [int64]$hello.appPid -le 0) {
          throw [ShepPipeRefusal]::new('REFUSED', 'the operator client is not this core instance')
        }
        [ShepPipe]::OperatorWrite($handle, [System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
        $greeted = $true
        $body = [ShepPipe]::OperatorRead($handle, 524288, 10000)
        # Never reuse PowerShell's automatic pipeline-input variable: any reference to it makes PowerShell bind
        # pipeline input, which consumes the stdin this file protocol reads.
        $operatorRequest = [System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
        if ($null -eq $operatorRequest) { throw [ShepPipeRefusal]::new('UNSAFE', 'the operator client sent no request') }
        if ($null -ne $operatorRequest.stop -and $operatorRequest.stop -is [bool] -and [bool]$operatorRequest.stop) {
          # A stop request still passes the boot handshake above; the application owns the decision and the drain.
        } else {
          if (-not ($operatorRequest.args -is [array]) -or $operatorRequest.args.Count -gt 16) {
            throw [ShepPipeRefusal]::new('UNSAFE', 'the operator request must carry at most 16 arguments')
          }
          foreach ($word in $operatorRequest.args) {
            if (-not ($word -is [string]) -or $word.Length -gt 256) {
              throw [ShepPipeRefusal]::new('UNSAFE', 'an operator argument is not a bounded word')
            }
          }
          if ($null -ne $operatorRequest.stdin) {
            if (-not ($operatorRequest.stdin -is [string]) -or [System.Text.Encoding]::UTF8.GetByteCount([string]$operatorRequest.stdin) -gt 65536) {
              throw [ShepPipeRefusal]::new('UNSAFE', 'the operator stdin value is not a bounded string')
            }
          }
        }
        try {
          [ShepPipe]::FrameWriteTagged($stdout, 1, $body)
        } catch {
          $fatal = $true
          throw
        }
        $tag = [byte]2
        try {
          $reply = [ShepPipe]::FrameReadTagged($stdin, 524289, 15000, 'the application did not answer the operator request in time', [ref]$tag)
          if ($tag -ne 2) { throw [ShepPipeRefusal]::new('UNAVAILABLE', 'the application sent an unexpected operator frame') }
        } catch {
          # A pending or superseded read on the application channel cannot be reused: the next reply would be handed to
          # the wrong client. End the helper instead of continuing on a desynchronised stream.
          $fatal = $true
          throw
        }
        $delivered = $true
        try { [ShepPipe]::OperatorWrite($handle, $reply) } catch { $delivered = $false }
        if ($delivered) {
          # WriteFile only fills the pipe buffer, and disconnecting drops what the client did not read. The client must
          # answer with the fixed receipt below once it has read the whole reply, so tag 3 means delivery, not a queued
          # write. A client that stays silent past this bounded wait is treated as undelivered.
          try {
            $receipt = [System.Text.Encoding]::UTF8.GetString([ShepPipe]::OperatorRead($handle, 64, 5000))
            if ($receipt -ne '{"received":true}') { $delivered = $false }
          } catch {
            $delivered = $false
          }
        }
        if ($delivered) {
          # The application learns that the client already has the reply, so a stop callback can run after this flush.
          try { [ShepPipe]::FrameWriteTagged($stdout, 3, [byte[]]@()) } catch { $fatal = $true; throw }
        } else {
          # The client vanished before it received the reply. Tell the application to forget it, so a stop that never
          # reached the caller is not drained later on the strength of an unrelated acknowledgement.
          try { [ShepPipe]::FrameWriteTagged($stdout, 4, [byte[]]@()) } catch { $fatal = $true; throw }
        }
      } catch {
        if ($fatal) { throw }
        $refusal = Get-PipeRefusal $_
        $message = if ($null -ne $refusal) { $refusal.Message } else { $_.Exception.Message }
        try {
          if ($greeted) {
            [ShepPipe]::OperatorWrite($handle, [System.Text.Encoding]::UTF8.GetBytes((Format-OperatorReply ($message + "`n") 1)))
          } else {
            [ShepPipe]::OperatorWrite($handle, [System.Text.Encoding]::UTF8.GetBytes((@{ ok = $false; error = $message } | ConvertTo-Json -Compress)))
          }
        } catch {}
      } finally {
        [ShepPipe]::OperatorDisconnect($handle)
      }
    }
  } catch {
    $refusal = Get-PipeRefusal $_
    if ($null -ne $refusal) {
      $exitCode = [ShepPipe]::RefuseOperator($refusal.Code, $refusal.Message)
    } else {
      $message = $_.Exception.Message
      if ($message.Length -gt 300) { $message = $message.Substring(0, 300) }
      [Console]::Error.WriteLine('shepherdr-operator UNSAFE: ' + $message.Replace("`r", ' ').Replace("`n", ' '))
      $exitCode = 4
    }
  } finally {
    [ShepPipe]::OperatorClose($handle)
  }
  exit $exitCode
}

# Private operator client: watches the caller that started it, connects once, verifies that exact connected handle (owner,
# protected DACL, server account, session, non-elevated medium integrity), sends the boot handshake, and only after
# {"ok":true} sends the request that may carry a secret. The reply is printed as one bounded JSON object, and the client
# then sends the fixed receipt the server waits for, so the application is told the caller really has the reply before
# it acts on a stop.
if ($Operation -eq 'operatorClient') {
  $exitCode = 1
  $pipe = $null
  try {
    $stdin = [Console]::OpenStandardInput()
    $control = Read-ControlLine $stdin 1048576 | ConvertFrom-Json
    if ($null -eq $control -or $control.operation -ne $Operation) { throw [ShepError]::new('UNSAFE', 'operation mismatch') }
    $full = [string]$control.pipe
    $name = Get-OperatorPipe $full 'the private operator endpoint'
    if (-not ($control.hello -is [pscustomobject]) -or -not ($control.request -is [string])) {
      throw [ShepError]::new('UNSAFE', 'the operator client needs a boot identity and one request')
    }
    $boot = [string]$control.hello.boot
    if ($boot -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
      throw [ShepError]::new('UNSAFE', 'the operator boot identity is not a boot id')
    }
    # The application pid is the caller this request is for, never the pid of this helper and never the pin of the
    # operator server: the server half compares the pid that actually owns the connected handle (this helper) with the
    # hello below, and the boot plus the published helper pid already pin the instance this request belongs to.
    $appPid = [int64]$control.hello.appPid
    if ($appPid -le 0) { throw [ShepPipeRefusal]::new('UNSAFE', 'the operator client has no application pid') }
    # The caller that started this client helper is the only reason a stop may be sent. Watch it before connecting: if
    # that process dies first, this helper exits instead of delivering an authenticated request for a dead caller.
    $callerPid = [int64]$control.parentPid
    if ($callerPid -le 0) { throw [ShepPipeRefusal]::new('UNSAFE', 'the operator client control line names no caller process') }
    [ShepPipe]::WatchParent([int]$callerPid)
    $helperPid = [int64]$control.hello.helperPid
    if ($helperPid -le 0) { throw [ShepPipeRefusal]::new('UNSAFE', 'the operator client has no helper pid') }
    $body = [System.Text.Encoding]::UTF8.GetBytes([string]$control.request)
    if ($body.Length -gt 524288) { throw [ShepPipeRefusal]::new('TOOLARGE', 'the operator request is larger than 512 KiB') }
    $connectMs = [int]$control.connectMs
    if ($connectMs -lt 1) { $connectMs = 1 }
    if ($connectMs -gt 60000) { $connectMs = 60000 }
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous, [System.IO.Pipes.TokenImpersonationLevel]::Identification, [System.IO.Pipes.HandleInheritability]::None)
    try { $pipe.Connect($connectMs) }
    catch [System.TimeoutException] { throw [ShepPipeRefusal]::new('TIMEOUT', 'timed out connecting to ' + $full) }
    [ShepPipe]::VerifyClient($pipe, $full, [int]$helperPid)
    $hello = @{ boot = $boot; appPid = $appPid; helperPid = $helperPid; pid = [int64]$PID } | ConvertTo-Json -Compress
    [ShepPipe]::FrameWrite($pipe, [System.Text.Encoding]::UTF8.GetBytes($hello))
    $answer = ([System.Text.Encoding]::UTF8.GetString([ShepPipe]::FrameRead($pipe, 4096, 5000, 'the private operator did not answer the handshake in time'))) | ConvertFrom-Json
    if ($null -eq $answer -or -not ($answer.ok -is [bool]) -or -not [bool]$answer.ok) {
      $why = if ($null -ne $answer -and $null -ne $answer.error) { [string]$answer.error } else { 'the private operator did not accept this core instance' }
      throw [ShepPipeRefusal]::new('REFUSED', $why)
    }
    [ShepPipe]::FrameWrite($pipe, $body)
    $reply = [System.Text.Encoding]::UTF8.GetString([ShepPipe]::FrameRead($pipe, 524288, 15000, 'the private operator did not answer in time'))
    [Console]::Out.Write($reply)
    [Console]::Out.Flush()
    # The server waits for this fixed receipt before it tells the application that the reply arrived. Disconnecting
    # right after the write would drop whatever the server had not read yet, and the application would fire a stop
    # callback for a reply the caller never saw. Printing first keeps the reply visible even if this last write fails.
    [ShepPipe]::FrameWrite($pipe, [System.Text.Encoding]::UTF8.GetBytes('{"received":true}'))
    $exitCode = 0
  } catch {
    $refusal = Get-PipeRefusal $_
    if ($null -ne $refusal) {
      $exitCode = [ShepPipe]::RefuseOperator($refusal.Code, $refusal.Message)
    } else {
      $message = $_.Exception.Message
      if ($message.Length -gt 300) { $message = $message.Substring(0, 300) }
      [Console]::Error.WriteLine('shepherdr-operator UNSAFE: ' + $message.Replace("`r", ' ').Replace("`n", ' '))
      $exitCode = 4
    }
  } finally {
    if ($null -ne $pipe) { try { $pipe.Dispose() } catch {} }
  }
  exit $exitCode
}

$answer = @{ ok = $false; code = 'UNSAFE'; error = 'operation did not run' }
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  if ($null -eq $request -or $request.operation -ne $Operation) { throw [ShepError]::new('UNSAFE', 'operation mismatch') }
  switch ($Operation) {
    'verifyDirectory' {
      Assert-PrivateDirectory ([string]$request.path)
      $answer = @{ ok = $true }
    }
    'createDirectory' {
      New-PrivateDirectory ([string]$request.path)
      $answer = @{ ok = $true }
    }
    'readFile' {
      $answer = @{ ok = $true; data = (Read-PrivateFile ([string]$request.path) ([int]$request.max)) }
    }
    'readPlainFile' {
      $read = Read-PlainFile ([string]$request.path) ([int]$request.max)
      $answer = @{ ok = $true; data = $read.Data; path = $read.Path }
    }
    'readPlainFileHead' {
      $head = Read-PlainFileHead ([string]$request.path) ([int]$request.max)
      $answer = @{ ok = $true; data = $head.Data; path = $head.Path; size = $head.Size }
    }
    'writeFile' {
      Write-PrivateFile ([string]$request.path) ([Convert]::FromBase64String([string]$request.data)) ([bool]$request.exclusive)
      $answer = @{ ok = $true }
    }
    'publishPlainFile' {
      $published = Publish-PlainFile ([string]$request.directory) ([string]$request.leaf) ([Convert]::FromBase64String([string]$request.data))
      $answer = @{ ok = $true; identity = $published.identity; size = $published.size }
    }
    'deleteFile' {
      Delete-PrivateFile ([string]$request.path)
      $answer = @{ ok = $true }
    }
    'verifyFile' {
      $info = Verify-PrivateFile ([string]$request.path)
      $answer = @{ ok = $true; identity = $info.identity; size = $info.size }
    }
    'verifyDescriptor' {
      # Test seam: validates a caller-supplied security descriptor with the same private-DACL rules. It touches no
      # filesystem object and returns nothing but a refusal reason, so it cannot grant access to anything.
      $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new([Convert]::FromBase64String([string]$request.descriptor), 0)
      Assert-Descriptor $raw $currentSid 'descriptor' $false
      $answer = @{ ok = $true }
    }
    'verifyPipeDescriptor' {
      # Test seam: validates a caller-supplied descriptor with the pipe rules the connected pipe is held to. It touches
      # no pipe and returns nothing but a refusal reason, so it cannot grant access to anything.
      [ShepPipe]::AssertDescriptorBase64([string]$request.descriptor)
      $answer = @{ ok = $true }
    }
    'holdFile' {
      $info = Hold-PrivateFile ([string]$request.path) ([int]$request.waitMs)
      $answer = @{ ok = $true; identity = $info.identity; size = $info.size }
    }
  }
} catch {
  $code = 'UNSAFE'
  $message = $_.Exception.Message
  $shep = Get-ShepError $_
  if ($null -ne $shep) {
    $code = $shep.Code
    $message = $shep.Message
  } else {
    $refusal = $null
    $probe = $_.Exception
    while ($null -ne $probe) {
      if ($probe -is [ShepPipeRefusal]) { $refusal = $probe; break }
      $probe = $probe.InnerException
    }
    if ($null -ne $refusal) {
      $code = $refusal.Code
      $message = $refusal.Message
    } else {
      $native = Get-Win32Code $_
      if ($native -ne 0) {
        $code = Map-Code $native
        $message = $_.Exception.Message
      }
    }
  }
  $answer = @{ ok = $false; code = $code; error = $message }
}
[Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress -Depth 4))
