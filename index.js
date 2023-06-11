import { init, WASI } from 'https://esm.sh/@wasmer/wasi@1.1.2'
import Llc from './llc.js'
import Lld from './lld.js'

await init()

export const compileAndRun = async (mainLl) => {
    const llc = await Llc()
    llc.FS.writeFile('main.ll', mainLl)
    await llc.callMain(['-filetype=obj', 'main.ll'])
    const mainO = llc.FS.readFile('main.o')

    const lld = await Lld()
    lld.FS.writeFile('main.o', mainO)
    await lld.callMain([
        '-flavor',
        'wasm',
        '-L/lib/wasm32-wasi',
        '-lc',
        '-lc++',
        '-lc++abi',
        '/lib/clang/16.0.4/lib/wasi/libclang_rt.builtins-wasm32.a',
        '/lib/wasm32-wasi/crt1.o',
        'main.o',
        '-o',
        'main.wasm',
    ])
    const mainWasm = lld.FS.readFile('main.wasm')

    const wasi = new WASI({})
    const module = await WebAssembly.compile(mainWasm)
    const instance = await WebAssembly.instantiate(module, {
        ...wasi.getImports(module)
    })
    wasi.start(instance)
    const stdout = await wasi.getStdoutString()

    return stdout
}
