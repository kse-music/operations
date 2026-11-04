use crate::{failure, protocol::*};
use serde_json::Value;
use serverdeck_core::Error;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use wasmi::{
    Config, EnforcedLimits, Engine, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder,
    TypedFunc,
};

pub const FUEL: u64 = 2_000_000;
pub const MEMORY: usize = 16 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct Vm {
    store: Store<StoreLimits>,
    memory: Memory,
    allocate: TypedFunc<i32, i32>,
    handle: TypedFunc<(i32, i32, i32), i64>,
    sequence: u64,
    cancelled: Arc<AtomicBool>,
    deadline: Duration,
}
impl Vm {
    pub fn new(bytes: &[u8], cancelled: Arc<AtomicBool>) -> Result<Self, Error> {
        if bytes.len() > serverdeck_plugin_core::package::MAX_FILE || !bytes.starts_with(b"\0asm") {
            return Err(failure(
                "PLUGIN_MODULE",
                "插件入口必须是大小受限的 WASM 二进制",
            ));
        }
        let mut config = Config::default();
        config
            .consume_fuel(true)
            .enforced_limits(EnforcedLimits::strict())
            .set_min_stack_height(1024)
            .set_max_stack_height(256 * 1024)
            .set_max_recursion_depth(256)
            .set_max_cached_stacks(0)
            .wasm_multi_memory(false)
            .wasm_memory64(false)
            .ignore_custom_sections(true);
        let started = Instant::now();
        let engine = Engine::new(&config);
        let module = Module::new(&engine, bytes).map_err(wasm_error)?;
        // No native/WASI imports; unresolved imports cannot acquire ambient authority.
        if module.imports().next().is_some() {
            return Err(failure(
                "PLUGIN_IMPORT",
                "插件请求了不受支持的原生或 WASI 导入",
            ));
        }
        let limits = StoreLimitsBuilder::new()
            .memory_size(MEMORY)
            .memories(1)
            .tables(1)
            .table_elements(4096)
            .instances(1)
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(&engine, limits);
        store.limiter(|limits| limits);
        store.set_fuel(FUEL).map_err(wasm_error)?;
        let instance = Linker::<StoreLimits>::new(&engine)
            .instantiate_and_start(&mut store, &module)
            .map_err(wasm_error)?;
        let api = instance
            .get_typed_func::<(), i32>(&store, "sd_api_version")
            .map_err(wasm_error)?;
        if api.call(&mut store, ()).map_err(wasm_error)? != PROTOCOL_VERSION as i32 {
            return Err(failure("PLUGIN_PROTOCOL", "插件消息协议版本不兼容"));
        }
        let memory = instance
            .get_memory(&store, "memory")
            .ok_or_else(|| failure("PLUGIN_ABI", "插件缺少导出的线性内存"))?;
        let allocate = instance
            .get_typed_func(&store, "sd_alloc")
            .map_err(wasm_error)?;
        let handle = instance
            .get_typed_func(&store, "sd_handle")
            .map_err(wasm_error)?;
        if started.elapsed() > TIMEOUT || cancelled.load(Ordering::Acquire) {
            return Err(failure("PLUGIN_TIMEOUT", "插件启动超时或已取消"));
        }
        Ok(Self {
            store,
            memory,
            allocate,
            handle,
            sequence: 0,
            cancelled,
            deadline: TIMEOUT,
        })
    }
    pub fn call(&mut self, operation: Operation, payload: Value) -> Result<Reply, Error> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(failure("PLUGIN_CANCELLED", "插件请求已取消"));
        }
        self.sequence += 1;
        let bytes = serde_json::to_vec(&Message {
            protocol_version: PROTOCOL_VERSION,
            request_id: self.sequence,
            operation,
            payload,
        })
        .map_err(|e| Error::Worker(Box::new(e)))?;
        if bytes.len() > MAX_MESSAGE {
            return Err(failure("PLUGIN_MESSAGE_LIMIT", "插件请求消息超过 64 KiB"));
        }
        self.store.set_fuel(FUEL).map_err(wasm_error)?;
        let started = Instant::now();
        let pointer = self
            .allocate
            .call(&mut self.store, bytes.len() as i32)
            .map_err(wasm_error)?;
        if pointer < 0 {
            return Err(failure("PLUGIN_ABI", "插件返回了非法内存地址"));
        }
        self.memory
            .write(&mut self.store, pointer as usize, &bytes)
            .map_err(|e| Error::Connection {
                code: "PLUGIN_ABI",
                message: "插件请求内存越界",
                source: Some(Box::new(e)),
            })?;
        let output = self
            .handle
            .call(
                &mut self.store,
                (operation as i32, pointer, bytes.len() as i32),
            )
            .map_err(wasm_error)? as u64;
        let address = (output >> 32) as usize;
        let length = (output & 0xffff_ffff) as usize;
        if length > MAX_MESSAGE {
            return Err(failure("PLUGIN_MESSAGE_LIMIT", "插件响应超过 64 KiB"));
        }
        let mut bytes = vec![0; length];
        self.memory
            .read(&self.store, address, &mut bytes)
            .map_err(|e| Error::Connection {
                code: "PLUGIN_ABI",
                message: "插件响应内存越界",
                source: Some(Box::new(e)),
            })?;
        if started.elapsed() > self.deadline {
            return Err(failure("PLUGIN_TIMEOUT", "插件请求超时"));
        }
        if self.cancelled.load(Ordering::Acquire) {
            return Err(failure("PLUGIN_CANCELLED", "插件请求已取消"));
        }
        let reply: Reply = serde_json::from_slice(&bytes).map_err(|e| Error::Connection {
            code: "PLUGIN_PROTOCOL",
            message: "插件返回了无效消息",
            source: Some(Box::new(e)),
        })?;
        if reply.protocol_version != PROTOCOL_VERSION
            || reply
                .error
                .as_ref()
                .is_some_and(|e| e.code.len() > 80 || e.message.len() > 1024)
        {
            return Err(failure("PLUGIN_PROTOCOL", "插件响应协议或错误字段无效"));
        }
        Ok(reply)
    }
}
fn wasm_error(source: wasmi::Error) -> Error {
    let code = if source.as_trap_code() == Some(wasmi::TrapCode::OutOfFuel) {
        "PLUGIN_FUEL"
    } else {
        "PLUGIN_TRAP"
    };
    Error::Connection {
        code,
        message: "插件 WASM 执行失败或超出资源配额",
        source: Some(Box::new(source)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_guest_exceeding_wall_deadline_reports_timeout() {
        let bytes = wat::parse_str(include_str!(
            "../../../tests/fixtures/plugins/hello-world/backend.wat"
        ))
        .unwrap();
        let mut vm = Vm::new(&bytes, Arc::new(AtomicBool::new(false))).unwrap();
        vm.deadline = Duration::ZERO;
        assert!(matches!(
            vm.call(Operation::Health, Value::Null),
            Err(Error::Connection {
                code: "PLUGIN_TIMEOUT",
                ..
            })
        ));
    }
}
