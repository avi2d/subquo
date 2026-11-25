import { $ } from "bun";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const output = (process.argv[2] ?? `${root}release-assets`).replace(/\/+$/, "");
const name = `subquo-${process.platform}-${process.arch}`;
const executable = `${output}/${name}`;

if (!((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64"))) {
  console.error("Release assets require Linux x64 or macOS arm64");
  process.exitCode = 1;
} else {
  await $`mkdir -p ${output}`;
  const result = await Bun.build({
    entrypoints: [`${root}src/cli.ts`],
    compile: { outfile: executable },
    bytecode: true,
    format: "esm",
  });
  if (!result.success) {
    console.error("Could not compile subquo", result.logs);
    process.exitCode = 1;
  } else {
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(executable).arrayBuffer()).digest("hex");
    await Bun.write(`${executable}.sha256`, `${digest}  ${name}\n`);
    console.log(executable);
    console.log(`${executable}.sha256`);
  }
}
