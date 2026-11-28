const twoWords = new Set(`bazel brew bun cargo cdk cf cmake composer consul crictl deno doctl docker eksctl firebase flyctl
git go gradle helm heroku hugo ip kind kubectl kustomize make mc minikube mongosh mysql mvn ng npm npx nvm nx openssl
pip pipenv pnpm poetry podman psql pulumi python pyenv rake rbenv redis-cli rustup serverless sfdx skaffold sls sst
swift systemctl terraform tmux turbo ufw vault vercel volta wp yarn`.split(/\s+/));
const threeWords = new Set(`bun run,bun x,cargo add,cargo run,consul kv,deno task,docker builder,docker compose,docker container,docker image,docker network,docker volume,eksctl create,git config,git remote,git stash,ip addr,ip link,ip netns,ip route,kind create,kubectl kustomize,kubectl rollout,mc admin,npm exec,npm init,npm run,npm view,openssl req,openssl x509,pnpm dlx,pnpm exec,pnpm run,podman container,podman image,pulumi stack,terraform workspace,vault auth,vault kv,yarn dlx,yarn run`.split(","));
const threeWordHeads = new Set(["aws", "az", "gcloud", "gh"]);
const specialHeads = new Set(`if then elif else fi case esac for select until while do done in function repeat coproc time
alias declare typeset local export readonly unset unsetenv cd chdir pushd popd push-location set-location`.split(/\s+/));

function prefix(words: string[]) {
  const head = words[0] ?? "";
  const count = threeWordHeads.has(head) || threeWords.has(words.slice(0, 2).join(" ")) ? 3 : twoWords.has(head) ? 2 : 1;
  return `${words.slice(0, count).join(" ")} *`;
}

function simpleCommands(command: string) {
  const commands: { resource: string; save: string }[] = [];
  const token = /[ \t]+|&&|\|\||[;|\n]|[\w./,:@%+=-]+|'[^'\r\n]*'|"[^"\\$`\r\n]*"/y;
  let start = 0;
  let end = 0;
  let word = "";
  let words: string[] = [];
  let awaitingCommand = false;
  const finishWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const finishCommand = () => {
    finishWord();
    const head = words[0];
    if (!head || !/^[\w./-]+$/.test(head) || specialHeads.has(head)) return false;
    const save = prefix(words);
    if (/[*?\\]/.test(save.slice(0, -2))) return false;
    commands.push({ resource: command.slice(start, end), save });
    words = [];
    return true;
  };
  while (token.lastIndex < command.length) {
    const match = token.exec(command);
    if (!match) return;
    const [part] = match;
    if (part === "\n" || part === ";" || part === "|" || part === "||" || part === "&&") {
      if (!word && !words.length && part === "\n") continue;
      if (!finishCommand()) return;
      awaitingCommand = part !== "\n" && part !== ";";
    } else if (part.startsWith(" ") || part.startsWith("\t")) {
      finishWord();
    } else {
      if (!word && !words.length) start = match.index;
      word += part;
      end = token.lastIndex;
      awaitingCommand = false;
    }
  }
  if ((word || words.length) && !finishCommand()) return;
  if (!awaitingCommand && commands.length) return commands;
}

export function shellPermissions(command: string) {
  const commands = simpleCommands(command);
  if (commands) return { action: "shell", resources: commands.map(item => item.resource), save: commands.map(item => item.save) };
  const exactEnginePattern = process.platform !== "win32" && !/[*?/\\]/.test(command);
  return { action: "shell", resources: [command], save: exactEnginePattern ? [command] : [], confirm: true };
}
