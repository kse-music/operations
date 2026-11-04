(module
  (memory (export "memory") 2 256)
  (data (i32.const 0) "{\22protocolVersion\22:1,\22result\22:{\22message\22:\22hello from isolated wasm\22},\22error\22:null}")
  (func (export "sd_api_version") (result i32) (i32.const 1))
  (func (export "sd_alloc") (param i32) (result i32) (i32.const 65536))
  (func (export "sd_handle") (param i32 i32 i32) (result i64) (i64.const 82))
)
