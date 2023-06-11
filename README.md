Quick (incomplete) overview of the compilation process w/ LLVM:
```
*.c
 |
 | clang -cc1
 v
*.ll
 |         ^
 | llvm-as | llvm-dis
 v         |
*.bc
 |
 | llvm-link + *.a (native static libs) + *.bc (bitcode)
 v
*.bc
 |
 | llc
 v
*.s
 |
 | as
 v
*.o
 |
 | lld + *.a (native static libs) + *.o (native obj files)
 v
 🎉 (native binary)
```

There are many prior arts to getting parts of the LLVM toolchain running on the browser:
- Alon Zakai's [llvm.js](http://kripken.github.io/llvm.js/demo.html) [GitHub](https://github.com/kripken/llvm.js)

This is perhaps the first successful attempt at this. It (appears to?) execute the LLVM IR directly using an earlier version of Emscripten (which was in JavaScript). `llvm-as` and `llvm-dis` are used for LLVM IR validation and pretty-printing. This approach probably doesn't work anymore as Emscripten (or at least the SDK) now requires Node.js and Python, among other things.
- Todd Fleming's [cib](https://tbfleming.github.io/cib/) [GitHub](https://github.com/tbfleming/cib)

This (appears to?) compile `clang` along with a ([bespoke?](https://github.com/tbfleming/cib/blob/master/src/rtl/CMakeLists.txt)) WASM runtime with Emscripten. No idea how all this works, the build scripts are... not pretty.
- Ben Smith's [wasm-clang](https://binji.github.io/wasm-clang/) [GitHub](https://github.com/binji/wasm-clang)

This is the latest attempt I can find, and makes use of [WASI](https://github.com/bytecodealliance/wasmtime/blob/main/docs/WASI-intro.md). It compiles `clang` and `lld` to WASI using a [hacked LLVM source](https://github.com/binji/llvm-project). It gets access to libc through a custom in-memory file system.

The approach done here is a mix between `llvm.js` and `wasm-clang`: we compile `llc` & `lld` using Emscripten. `llc` is used to compile the LLVM IR to a wasm32-wasi object file. The object file is run through `lld` along with (WASI) libc into a wasm32-wasi binary.

For `lld` to find libc, we need to create an in-memory file system, like in `wasm-clang`. Fortunately, Emscripten provides this, so all we need to do is to preload the WASI sysroot (which includes libc) into Emscripten's virtual filesystem.

After running the linker, we now have a wasm binary, but this isn't enough to run it on the browser. WASI hasn't been standardized yet, so there isn't native browser support for it, so we need some sort of polyfill. Fortunately, Wasmer provides just that with [@wasmer/wasi](https://github.com/wasmerio/wasmer-js), which they used for [wasm-terminal](https://www.infoq.com/news/2019/10/wasmer-js-wasi-wasm-browser/).

And with that, we can run the wasm binary and you're off to the races! :)

Now for the build steps...
# Building `llc` & `lld`
This was done on a AWS EC2 c6i.metal. Here we compile LLVM 14.0.6 - make sure the version number is consistent on every step.
## Packages
```sh
sudo apt-get -y update
sudo apt-get -y install cmake g++ git lbzip2 ninja-build python3
```
## Emscripten
```sh
git clone --branch 3.1.40 --depth 1 https://github.com/emscripten-core/emsdk
cd emsdk
./emsdk install 3.1.40
./emsdk activate 3.1.40
source ./emsdk_env.sh
echo "source $PWD/emsdk_env.sh" >> $HOME/.bashrc
cd ..
```
## WASI sysroot
As mentioned in the preface, we need the WASI sysroot to provide the linker with libc. You also need the clang compiler runtime. Get these [here](https://github.com/WebAssembly/wasi-sdk/releases). These are `wasi-sysroot-x.y.tar.gz` and `libclang_rt.builtins-wasm32-wasi-x.y.tar.gz` respectively.
```sh
wget -qO- https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-20/wasi-sysroot-20.0.tar.gz | tar -xz
wget -qO- https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-20/libclang_rt.builtins-wasm32-wasi-20.0.tar.gz | tar -xz
mkdir -p wasi-sysroot/lib/clang/16.0.4
mv lib wasi-sysroot/lib/clang/16.0.4/
```
## Cross-compile `llc` & `lld`
```sh
git clone --branch llvmorg-16.0.4 --depth 1 https://github.com/llvm/llvm-project
cd llvm-project

# For the actual build, we need to have llvm-tblgen built for the host
cmake -G Ninja -S llvm -B build-host -DCMAKE_BUILD_TYPE=Release
cmake --build build-host --target llvm-tblgen

# No easy way to set flags just for lld, so we modify the cmake file directly
echo "set_target_properties(lld PROPERTIES LINK_FLAGS --preload-file=../../wasi-sysroot/lib@/lib)" >> llvm/CMakeLists.txt

EMCC_DEBUG=2 \
CXXFLAGS="-Dwait4=__syscall_wait4" \
LDFLAGS="-s NO_INVOKE_RUN -s EXIT_RUNTIME -s INITIAL_MEMORY=64MB -s ALLOW_MEMORY_GROWTH -s EXPORTED_RUNTIME_METHODS=FS,callMain -s MODULARIZE -s EXPORT_ES6 -s WASM_BIGINT" \
emcmake cmake -G Ninja -S llvm -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=install \
  -DLLVM_TARGET_ARCH=wasm32-emscripten \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasi \
  -DLLVM_ENABLE_PROJECTS=lld \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_TABLEGEN=$PWD/build-host/bin/llvm-tblgen
cmake --build build
```
## Download build artifacts
```sh
cd build
tar -czvf bin.tgz bin/{llc,lld}.*
```
And then locally:
```sh
scp <build-machine-address>:~/llvm-project/build/bin.tgz .
tar -zxf bin.tgz
mv bin/* .
rmdir bin
```
Now you can stop the build machine instance. You should have `llc.js`, `llc.wasm`, `lld.data`, `lld.js`, `lld.wasm` on your local machine.
# WASI browser polyfill
We use [@wasmer/wasi](https://www.npmjs.com/package/@wasmer/wasi) as the WASI polyfill.
# Etc.
For more details on how to use the polyfill and resulting artifacts, feel free to pore through `index.js`. These references might be helpful:
- [Emscripten's File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html#filesystem-api)
- [@wasmer/wasi docs](https://docs.wasmer.io/integrations/js/reference-api/wasmer-wasi)

Good luck!
