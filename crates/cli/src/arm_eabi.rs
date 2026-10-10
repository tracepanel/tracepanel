//! ARM EABI helpers for unaligned loads and stores, on armv6 musl (Raspberry Pi 1 and Zero).
//!
//! Rust's standard library calls them there (its backtrace symbolizer reads unaligned data), and they usually come
//! from libgcc; the wheels link with zig, whose compiler runtime leaves them out. Each is the plain unaligned access.

#[unsafe(no_mangle)]
pub unsafe extern "C" fn __aeabi_uread4(address: *const u32) -> u32 {
    // SAFETY: the caller passes a readable address; only its alignment is unknown.
    unsafe { address.read_unaligned() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn __aeabi_uwrite4(value: u32, address: *mut u32) -> u32 {
    // SAFETY: the caller passes a writable address; only its alignment is unknown.
    unsafe { address.write_unaligned(value) };
    value
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn __aeabi_uread8(address: *const u64) -> u64 {
    // SAFETY: as above.
    unsafe { address.read_unaligned() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn __aeabi_uwrite8(value: u64, address: *mut u64) -> u64 {
    // SAFETY: as above.
    unsafe { address.write_unaligned(value) };
    value
}
