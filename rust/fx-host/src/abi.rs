//! The WebAssembly ABI: a C-compatible export surface over [`Session`].
//!
//! This file holds the crate's only unsafe code. It compiles for `wasm32` only, the
//! module it produces imports nothing, and every export validates its handle before
//! use. The wasm instance is the isolation boundary: a host that passes a bad pointer
//! can corrupt only its own instance's memory.
//!
//! Calling convention (all integers are `i32`/`u32`, all pointers are linear-memory
//! offsets):
//!
//! 1. `fx_abi_version()` and `fx_protocol_version()` must match the host's.
//! 2. `fx_alloc(len)` returns a buffer the host fills; `fx_free(ptr, len)` releases it.
//! 3. `fx_session_new(flags)` returns a session handle (0 on failure);
//!    `fx_session_free(handle)` releases it.
//! 4. `fx_begin(handle, ptr, len)` takes the raw FX request document; `fx_command`
//!    takes a JSON command. Each returns the length of the JSON response, readable at
//!    `fx_output_ptr(handle)` until the next call, or a negative error code.
//!
//! Panics trap the instance. A host must discard a trapped instance.
#![allow(unsafe_code)]

use crate::{ABI_VERSION, PROTOCOL_VERSION, Session, SupportFlags};

const MAGIC: u32 = 0x4658_5353;

/// A negative return: the handle is null or not a session.
const ERR_HANDLE: i32 = -1;
/// A negative return: the response does not fit in an `i32` length.
const ERR_SIZE: i32 = -2;

/// A session plus its last response, owned by the instance.
pub struct Handle {
    magic: u32,
    session: Session,
    output: Vec<u8>,
}

/// The ABI version.
#[unsafe(no_mangle)]
pub extern "C" fn fx_abi_version() -> u32 {
    ABI_VERSION
}

/// The host protocol version.
#[unsafe(no_mangle)]
pub extern "C" fn fx_protocol_version() -> u32 {
    PROTOCOL_VERSION
}

/// Allocates `len` bytes in linear memory for the host to fill.
#[unsafe(no_mangle)]
pub extern "C" fn fx_alloc(len: u32) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len as usize);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Releases a buffer from [`fx_alloc`].
///
/// # Safety
/// `ptr` and `len` must be exactly a pair returned by and given to `fx_alloc`, and the
/// buffer must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fx_free(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        // SAFETY: the caller guarantees `ptr`/`len` came from `fx_alloc`, which leaked a
        // `Vec<u8>` with capacity `len` and length 0.
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len as usize) });
    }
}

/// Creates a session. `flags` is a [`SupportFlags`] bit set. Returns a handle.
#[unsafe(no_mangle)]
pub extern "C" fn fx_session_new(flags: u32) -> *mut Handle {
    Box::into_raw(Box::new(Handle {
        magic: MAGIC,
        session: Session::new(SupportFlags(flags)),
        output: Vec::new(),
    }))
}

/// Releases a session.
///
/// # Safety
/// `handle` must be a value returned by `fx_session_new` that has not been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fx_session_free(handle: *mut Handle) {
    if handle.is_null() {
        return;
    }
    // SAFETY: the caller guarantees `handle` came from `fx_session_new` and is unfreed.
    let valid = unsafe { (*handle).magic == MAGIC };
    if valid {
        // SAFETY: as above; the magic check rejects a stale or foreign pointer on a
        // best-effort basis.
        let mut boxed = unsafe { Box::from_raw(handle) };
        boxed.magic = 0;
    }
}

/// Starts the attempt from a raw FX request document.
///
/// # Safety
/// `handle` must be a live session handle and `ptr`/`len` a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fx_begin(handle: *mut Handle, ptr: *const u8, len: u32) -> i32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { call(handle, ptr, len, Session::begin) }
}

/// Applies one JSON command.
///
/// # Safety
/// `handle` must be a live session handle and `ptr`/`len` a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fx_command(handle: *mut Handle, ptr: *const u8, len: u32) -> i32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { call(handle, ptr, len, Session::command) }
}

/// The last response of `handle`.
///
/// # Safety
/// `handle` must be a live session handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fx_output_ptr(handle: *mut Handle) -> *const u8 {
    if handle.is_null() {
        return std::ptr::null();
    }
    // SAFETY: the caller guarantees a live handle.
    let handle = unsafe { &*handle };
    if handle.magic != MAGIC {
        return std::ptr::null();
    }
    handle.output.as_ptr()
}

/// # Safety
/// `handle` must be a live session handle and `ptr`/`len` a readable range.
unsafe fn call(
    handle: *mut Handle,
    ptr: *const u8,
    len: u32,
    action: fn(&mut Session, &[u8]) -> Vec<u8>,
) -> i32 {
    if handle.is_null() {
        return ERR_HANDLE;
    }
    // SAFETY: the caller guarantees a live handle.
    let handle = unsafe { &mut *handle };
    if handle.magic != MAGIC {
        return ERR_HANDLE;
    }
    let input: &[u8] = if len == 0 || ptr.is_null() {
        &[]
    } else {
        // SAFETY: the caller guarantees `ptr..ptr+len` is readable.
        unsafe { std::slice::from_raw_parts(ptr, len as usize) }
    };
    handle.output = action(&mut handle.session, input);
    i32::try_from(handle.output.len()).unwrap_or(ERR_SIZE)
}
