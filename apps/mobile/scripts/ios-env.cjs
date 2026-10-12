const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const appRoot = path.resolve(__dirname, "..");
const iosRoot = path.join(appRoot, "ios");
const repoRoot = path.resolve(appRoot, "..", "..");
const xcodeWorkspaceName = "Dolgate.xcworkspace";
const legacyIosBundleIds = ["com.dolgate.mobile"];

function hasExecutable(candidatePath) {
  return Boolean(candidatePath && fs.existsSync(candidatePath));
}

function resolveDeveloperDir() {
  const candidates = [
    process.env.DEVELOPER_DIR,
    "/Applications/Xcode.app/Contents/Developer",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      hasExecutable(path.join(candidate, "usr", "bin", "xcodebuild")) &&
      fs.existsSync(path.join(candidate, "Applications", "Simulator.app"))
    ) {
      return candidate;
    }
  }

  return null;
}

function buildEnvForIos(baseEnv) {
  const env = { ...baseEnv };
  const extraPaths = [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"];
  const developerDir = resolveDeveloperDir();

  env.NODE_BINARY = env.NODE_BINARY || process.execPath;
  // CocoaPods 는 경로에 unicode_normalize 를 걸어서, 로케일이 없으면(LANG 미설정 →
  // ASCII-8BIT) `pod install` 이 Ruby 스택트레이스와 함께 죽는다. 원인을 알아보기
  // 어려운 실패라 UTF-8 로케일을 기본값으로 채운다.
  env.LANG = env.LANG || "en_US.UTF-8";
  if (developerDir) {
    env.DEVELOPER_DIR = developerDir;
    extraPaths.push(path.join(developerDir, "usr", "bin"));
  }

  env.PATH = [...extraPaths, env.PATH || ""].filter(Boolean).join(path.delimiter);
  return env;
}

function ensureXcodeAvailable(env) {
  const result = spawnSync("xcodebuild", ["-version"], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    "Xcode를 찾지 못했습니다. /Applications/Xcode.app 이 설치되어 있는지 확인해 주세요.",
  );
}

function ensureCocoaPodsAvailable(env) {
  const result = spawnSync("pod", ["--version"], {
    cwd: iosRoot,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    "CocoaPods를 찾지 못했습니다. `brew install cocoapods` 후 다시 시도해 주세요.",
  );
}

function readFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

// Collects the local paths Podfile.lock recorded for its externally sourced
// pods, resolved against the ios directory the lock lives in.
function getExternalSourcePaths(podfileLockContent) {
  const externalPaths = [];
  let insideSection = false;

  for (const line of podfileLockContent.split("\n")) {
    // Section headers sit at column zero; everything under them is indented.
    if (line.trim().length > 0 && !line.startsWith(" ")) {
      insideSection = line.startsWith("EXTERNAL SOURCES:");
      continue;
    }
    if (!insideSection) {
      continue;
    }

    const match = line.match(/^\s+:(?:path|podspec):\s*(.+?)\s*$/);
    if (match) {
      externalPaths.push(path.resolve(iosRoot, match[1].replace(/^"(.*)"$/, "$1")));
    }
  }

  return externalPaths;
}

/**
 * node_modules 에서 iOS 네이티브 코드를 들고 있는 패키지들의 절대 경로.
 *
 * RN 의 autolink 는 의존성 중 podspec 을 가진 것을 Podfile 에 이름을 적지 않고 자동으로 넣는다.
 * 그래서 **새 패키지를 깔면 Podfile 도 Podfile.lock 도 Manifest.lock 도 그대로**이고, 아래의
 * 다른 검사들이 모두 통과한다. 그 상태로 빌드하면 자바스크립트만 들어간 앱이 떠서, 그 모듈을
 * 처음 부르는 순간에야 없다고 터진다.
 *
 * dependencies 만 본다 — 네이티브를 들고 오는 패키지가 devDependencies 에 있을 이유가 없고,
 * 넓게 보면 그만큼 헛되게 `pod install` 을 돌릴 위험이 커진다.
 */
function getNativeDependencyPaths() {
  const manifest = readFileIfExists(path.join(appRoot, "package.json"));
  if (!manifest) {
    return [];
  }
  let dependencies;
  try {
    dependencies = Object.keys(JSON.parse(manifest).dependencies || {});
  } catch {
    return [];
  }

  const paths = [];
  for (const name of dependencies) {
    // 워크스페이스라 설치 위치가 앱과 저장소 뿌리 두 곳으로 갈린다.
    const packageDir = [
      path.join(appRoot, "node_modules", name),
      path.join(repoRoot, "node_modules", name),
    ].find((candidate) => fs.existsSync(candidate));
    if (!packageDir) {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(packageDir);
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.endsWith(".podspec"))) {
      paths.push(path.resolve(packageDir));
    }
  }

  return paths;
}

function shouldInstallPods() {
  const workspacePath = path.join(iosRoot, xcodeWorkspaceName);
  const podfilePath = path.join(iosRoot, "Podfile");
  const podfileLockPath = path.join(iosRoot, "Podfile.lock");
  const manifestLockPath = path.join(iosRoot, "Pods", "Manifest.lock");

  if (!fs.existsSync(workspacePath) || !fs.existsSync(podfileLockPath)) {
    return true;
  }

  const podfileStats = fs.statSync(podfilePath);
  const podfileLockStats = fs.statSync(podfileLockPath);
  if (podfileStats.mtimeMs > podfileLockStats.mtimeMs) {
    return true;
  }

  const podfileLockContent = readFileIfExists(podfileLockPath);

  // Most pods are autolinked from node_modules rather than named in the
  // Podfile, so deleting one leaves the Podfile untouched and both locks in
  // agreement — neither check above notices. The generated Pods project keeps
  // pointing at the vanished directory and the build dies on an (l)stat of a
  // framework that is no longer there, which reads as an Xcode problem rather
  // than a stale install. The recorded paths are the honest signal.
  const recordedPaths = getExternalSourcePaths(podfileLockContent);
  if (recordedPaths.some((externalPath) => !fs.existsSync(externalPath))) {
    return true;
  }

  // 반대 방향도 본다: 지운 pod 은 위에서 잡히지만 **새로 깐** pod 은 아무 파일도 건드리지
  // 않아 여기까지 통과한다. 기록된 경로가 그 패키지 안(또는 그 패키지 자체)을 가리키는지로
  // 본다 — react-native 처럼 하위 디렉터리 여러 개가 따로 적히는 경우가 있다.
  const linked = (dependencyPath) =>
    recordedPaths.some(
      (externalPath) =>
        externalPath === dependencyPath ||
        externalPath.startsWith(`${dependencyPath}${path.sep}`),
    );
  if (getNativeDependencyPaths().some((dependencyPath) => !linked(dependencyPath))) {
    return true;
  }

  return podfileLockContent !== readFileIfExists(manifestLockPath);
}

/**
 * `.xcode.env.local` 의 Node 경로가 사라졌으면 지금 Node 로 다시 쓴다.
 *
 * 이 파일은 RN 의 `pod install` 이 **없을 때만** 만들고, 그때의 `node` 절대 경로를 적는다. Node 가
 * 옮겨 가거나 지워지면(IDE 가 내려받은 Node 는 IDE 를 업데이트하면 폴더째 사라진다) 죽은 경로만
 * 남아 Xcode 의 RN 스크립트 단계가 "No such file or directory" 로 멈춘다. 우리가 넘기는
 * NODE_BINARY 환경 변수로는 못 막는다 — Xcode 가 이 파일을 나중에 읽어 덮어쓴다.
 *
 * 손으로 고치는 방법(파일을 지우고 `pod install`)과 같은 결과를 낸다. 경로가 살아 있거나 절대
 * 경로가 아니면(`node` 처럼 PATH 에서 찾게 둔 것) 손대지 않는다.
 */
function repairStaleXcodeEnvLocal(env) {
  const envLocalPath = path.join(iosRoot, ".xcode.env.local");
  if (!fs.existsSync(envLocalPath)) {
    // 없으면 `pod install` 이 만든다.
    return;
  }
  // Xcode 와 같은 방식(셸로 source)으로 읽는다 — `$(command -v node)` 같은 값도 그대로 풀린다.
  const result = spawnSync(
    "/bin/sh",
    ["-c", '. "$1" >/dev/null 2>&1; printf %s "$NODE_BINARY"', "sh", envLocalPath],
    { env: { ...env, NODE_BINARY: "" }, encoding: "utf8", timeout: 10_000 },
  );
  const configured = result.stdout ?? "";
  if (!path.isAbsolute(configured) || hasExecutable(configured)) {
    return;
  }

  // RN 이 이 파일을 만들 때 쓰는 이스케이프(Shellwords.escape)와 같은 규칙이다.
  const nodeBinary = process.execPath.replace(/[^A-Za-z0-9_\-.,:+/@]/g, "\\$&");
  fs.writeFileSync(envLocalPath, `export NODE_BINARY=${nodeBinary}\n`);
  console.log(
    `.xcode.env.local 의 Node(${configured})가 없어서 지금 Node(${process.execPath})로 바꿨습니다.`,
  );
}

function ensurePodsInstalled(env) {
  ensureCocoaPodsAvailable(env);
  // `pod install` 은 이 파일을 새로 만들 때만 경로를 적으니, 있던 파일은 여기서 본다.
  repairStaleXcodeEnvLocal(env);
  if (!shouldInstallPods()) {
    return;
  }

  const result = spawnSync("pod", ["install"], {
    cwd: iosRoot,
    env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("`pod install`에 실패했습니다.");
  }
}

function getAvailableSimulators(env) {
  const result = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    {
      cwd: appRoot,
      env,
      encoding: "utf8",
      timeout: 15_000,
    },
  );

  if (result.status !== 0) {
    return [];
  }

  const parsed = JSON.parse(result.stdout || "{}");
  const devices = Object.values(parsed.devices || {})
    .flat()
    .filter((device) => device && device.isAvailable)
    .map((device) => ({
      name: device.name,
      udid: device.udid,
      state: device.state,
    }));

  return devices;
}

function getPreferredSimulatorName(env) {
  if (process.env.DOLGATE_IOS_SIMULATOR) {
    return process.env.DOLGATE_IOS_SIMULATOR;
  }

  const simulators = getAvailableSimulators(env);
  const firstIPhone = simulators.find((simulator) =>
    simulator.name.startsWith("iPhone "),
  );
  return firstIPhone?.name ?? simulators[0]?.name ?? null;
}

function getExplicitDeviceSelection(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--udid" && next) {
      return { type: "udid", value: next };
    }
    if (arg === "--simulator" && next) {
      return { type: "simulator", value: next };
    }
  }
  return null;
}

function resolveSimulatorUdids(args, env) {
  const simulators = getAvailableSimulators(env);
  const explicitSelection = getExplicitDeviceSelection(args);

  if (explicitSelection?.type === "udid") {
    return [explicitSelection.value];
  }

  const simulatorName =
    explicitSelection?.type === "simulator"
      ? explicitSelection.value
      : getPreferredSimulatorName(env);
  if (!simulatorName) {
    return [];
  }

  return simulators
    .filter((simulator) => simulator.name === simulatorName)
    .map((simulator) => simulator.udid);
}

function removeLegacyIosApps(args, env) {
  const simulatorUdids = resolveSimulatorUdids(args, env);
  for (const simulatorUdid of simulatorUdids) {
    for (const bundleId of legacyIosBundleIds) {
      spawnSync("xcrun", ["simctl", "uninstall", simulatorUdid, bundleId], {
        cwd: appRoot,
        env,
        stdio: "ignore",
      });
    }
  }
}

function hasExplicitDeviceSelection(args) {
  return args.some((arg, index) => {
    if (["--simulator", "--device", "--udid"].includes(arg)) {
      return true;
    }
    const previous = args[index - 1];
    return Boolean(previous && ["--simulator", "--device", "--udid"].includes(previous));
  });
}

module.exports = {
  appRoot,
  iosRoot,
  buildEnvForIos,
  ensurePodsInstalled,
  ensureXcodeAvailable,
  getPreferredSimulatorName,
  hasExplicitDeviceSelection,
  removeLegacyIosApps,
};
