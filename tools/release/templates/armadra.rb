# Rendered by tools/release/publish-channels.mjs for {{repo}} {{tag}}.
# Published to the tap as Casks/armadra.rb (docs/guides/ci-release.md §3.1).
cask "armadra" do
  arch arm: "aarch64", intel: "x86_64"

  version "{{version}}"
  sha256 arm:   "{{sha256:darwin-aarch64.dmg}}",
         intel: "{{sha256:darwin-x86_64.dmg}}"

  url "{{downloadBase}}/v#{version}/Armadra_#{version}_darwin-#{arch}.dmg"
  name "Armadra"
  desc "Infinite canvas where AI coding agents collaborate"
  homepage "https://github.com/{{repo}}"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "Armadra.app"

  uninstall quit: "dev.armadra.desktop"

  zap trash: [
    "~/Library/Application Support/Armadra",
    "~/Library/Caches/dev.armadra.desktop",
    "~/Library/Caches/dev.armadra.desktop.ShipIt",
    "~/Library/Preferences/dev.armadra.desktop.plist",
    "~/Library/Saved Application State/dev.armadra.desktop.savedState",
  ]
end
