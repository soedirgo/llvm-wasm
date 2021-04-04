import { WASI } from 'https://unpkg.com/@wasmer/wasi@0.12.0/lib/index.esm.js'
import browserBindings from './browserBindings.js'
import { WasmFs } from 'https://unpkg.com/@wasmer/wasmfs@0.12.0/lib/index.esm.js'
import Llc from './llc.js'
import Lld from './lld.js'

export const compileAndRun = async (mainLl) => {
    const sysroot = await fetch('sysroot.tar')
        .then(res => res.arrayBuffer())
        .then(buf => new Uint8Array(buf));

    const wasmFs = new WasmFs()
    const wasi = new WASI({
        bindings: {
            ...browserBindings,
            fs: wasmFs.fs,
        }
    })

    const llc = await Llc()
    llc.FS.writeFile('main.ll', mainLl)
    await llc.callMain(['-filetype=obj', 'main.ll'])
    const mainO = llc.FS.readFile('main.o')

    const lld = await Lld()
    lld.FS.writeFile('main.o', mainO)

    { // untar sysroot to lld's FS
        let offset = 0;

        const readStr = (len = -1) => {
            let str = ''
            let end = sysroot.length
            if (len != -1) { end = offset + len }
            for (let i = offset; i < end && sysroot[i] != 0; ++i) { str += String.fromCharCode(sysroot[i]) }

            offset += len;
            return str;
        }

        const readOctal = (len) => {
            return parseInt(readStr(len), 8);
        }

        const alignUp = () => {
            offset = (offset + 511) & ~511;
        }

        const readEntry = () => {
            if (offset + 512 > sysroot.length) {
                return null;
            }

            const entry = {
                filename: readStr(100),
                mode: readOctal(8),
                owner: readOctal(8),
                group: readOctal(8),
                size: readOctal(12),
                mtim: readOctal(12),
                checksum: readOctal(8),
                type: readStr(1),
                linkname: readStr(100),
            };

            // NOTE: Use GNU tar instead of macOS's BSD tar.
            if (!readStr(8).startsWith('ustar')) {
                return null;
            }

            entry.ownerName = readStr(32);
            entry.groupName = readStr(32);
            entry.devMajor = readStr(8);
            entry.devMinor = readStr(8);
            entry.filenamePrefix = readStr(155);
            alignUp();

            if (entry.type === '0') {        // Regular file.
                entry.contents = sysroot.subarray(offset, offset + entry.size);
                offset += entry.size;
                alignUp();
            } else if (entry.type !== '5') { // Directory.
                console.log('type', entry.type);
                assert(false);
            }
            return entry;
        }

        let entry;
        while (entry = readEntry()) {
            switch (entry.type) {
                case '0': // Regular file.
                    lld.FS.writeFile(entry.filename, entry.contents);
                    break;
                case '5': // Directory.
                    lld.FS.mkdir(entry.filename);
                    break;
                default:
                    break;
            }
        }
    }

    await lld.callMain([
        '-flavor',
        'wasm',
        '-L/lib/wasm32-wasi',
        '-lc',
        '-lc++',
        '-lc++abi',
        '/lib/clang/11.1.0/lib/wasi/libclang_rt.builtins-wasm32.a',
        '/lib/wasm32-wasi/crt1.o',
        'main.o',
        '-o',
        'main.wasm',
    ])
    const mainWasm = lld.FS.readFile('main.wasm')

    const module = await WebAssembly.compile(mainWasm)
    const instance = await WebAssembly.instantiate(module, {
        ...wasi.getImports(module)
    })

    wasi.start(instance)
    const stdout = await wasmFs.getStdOut()
    return stdout
}
