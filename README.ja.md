[English](./README.md) | [日本語](./README.ja.md)

# Codex Reset Manager

Codex Reset Manager は、Codex のUsage WindowをmacOS上で監視するユーザー単位の
ツールです。アカウントのApp Serverが実際に公開する5時間枠とWeekly枠をモデル
実行なしで確認し、確認済みの枠がリセットされたときだけ、厳しく制限した、その時点で
利用可能なモデルの1ターンを使って新しい枠をanchorできます。

## このツールがすること／しないこと

- <code>codex app-server --stdio</code> とApp Serverのrate-limit機能だけを
  使います。非公開ChatGPT APIの呼び出し、OAuthトークンの読取、reset creditの
  消費はしません。
- 枠はlimit ID・bucket・durationで識別します。自動anchorの対象は300分と
  10,080分の枠だけです。
- ChatGPTのプラン名からUsage枠を推測しません。App ServerがWeekly枠だけを返す
  場合はWeekly枠だけを監視・anchorし、5時間枠がないことは正常です。対象枠が
  どちらも返らない場合も監視は続けますが、anchorは開始しません。
- anchorの直前に、現在のApp Serverの <code>model/list</code> が明示した候補から
  1組だけを選びます。許可するモデルの優先順は
  <code>gpt-5.6-luna</code>、<code>gpt-5.4-nano</code>、
  <code>gpt-5.4-mini</code>、<code>gpt-5.6-terra</code>、
  <code>gpt-5.4</code>、<code>gpt-5.6-sol</code>、
  <code>gpt-5.5</code> です。同じモデルでは、対応が明示された
  <code>none</code>、<code>low</code>、<code>medium</code>、
  <code>high</code>、<code>xhigh</code>、<code>max</code> の順に選びます。
- これは小さな固定プロンプト向けの監査済みallowlistと相対的な最低コスト優先順で
  あり、CodexサブスクリプションのUsageや残量を計算するものではありません。未知の
  モデルと <code>ultra</code> は選びません。既知モデルが許可されたeffortを明示
  していなければ、threadもturnも開始しません。
- 選択したモデル／effortの1組を <code>thread/start</code> と
  <code>turn/start</code> の両方に渡します。ephemeral threadの応答はその組と完全に
  一致しなければなりません。現在のApp Serverは <code>turn/start</code> にturn IDと
  statusだけを返し、経路をエコーしないことがあります。この未エコーは、すでに完全
  一致したthread応答で経路が固定されている場合だけ許可します。turn応答が経路の
  どちらかを返す場合は、両方が完全に一致しなければなりません。不一致、provider
  reroute、tool系イベント、承認要求では、次のターンを開始せずに拒否または中断します。
- 同じリセット世代へのanchorは最大1回です。送信前に世代を予約するため、結果が
  不明でも自動再送しません。
- reset時刻が変わったこと**だけ**を、新しい枠がすでに使われた証拠とはみなしません。
  保存済みの境界を過ぎた後、同じ枠について「より新しい将来cycleを示すreset時刻」と
  「Usageが正確に<code>0%</code>」を含む完全なスナップショットを確認してから、
  **元の**境界に対する候補を1件だけ作ります。Usageが0%より大きい場合は
  <code>skipped</code>として記録し、モデルターンを出さずに次の境界へ再基準化します。
  Usageや時刻の欠落、古い・遅延した観測、不整合、複数cycleをまたぐ観測も、
  モデルターンなしで安全側に倒します。
- 通常の5秒の猶予と30秒の集約待機があるため、自動の判定は表示されたreset時刻ちょうど
  ではなく、その後に行われます。モデルRPCの前に候補を永続保存する直前、完全なUsageを
  もう一度読みます。集約待機中に利用が現れた場合は、<code>thread/start</code>より前に
  候補を取り消します。
- 空の専用作業領域、ephemeral thread、read-only sandbox、ネットワーク無効、
  <code>approvalPolicy: never</code> を必須にします。永続threadへの
  フォールバックはしません。
- tool系イベント、承認要求、モデルrerouteを検出した場合はanchorを中断し、別の
  ターンを試さず <code>safety_abort</code>、<code>rejected</code>、
  <code>unverified</code> として記録します。

Heartbeat、定期モデル実行、カレンダーによるMacの起動要求はありません。Macを
意図的にスリープから起こさず、復帰・再起動時に監視を再照合します。

## 必要な環境

- macOS
- Node.js 22以降
- インストール済みかつ認証済みのCodex CLI
- <code>doctor</code> と <code>install</code> を実行する対話シェルから利用できる
  <code>codex</code> コマンド

インストール前に確認します。

~~~sh
node --version
command -v codex
codex --version
npm ci
npm run build
node dist/src/cli.js doctor
~~~

<code>doctor</code> はApp Server、認証、利用可能な最低コスト候補、Usage枠、
専用領域の空状態、ephemeral thread、通知可否、実行ファイルのパスを診断します。
選ばれたモデル／effort（または安全な候補がないこと）、解決されたCodex CLIのパス、
5時間枠／Weekly枠が個別に公開されているかを表示します。モデルターンは開始しません。

<code>install</code> は、その対話シェルからCodex CLIの絶対パスを解決して実行可能
か検証し、LaunchAgentのplistに保存します。常駐プロセスはlaunchdの最小
<code>PATH</code>ではなく、この正確なパスを使用します。Codex CLIを解決できない
場合は、既存Agentを置き換える前にインストールを停止します。

## 対応OSとUsage枠の扱い

このツールはmacOS専用です。Codex CLI自体はWindowsで利用できる場合がありますが、
本ツールはmacOSのLaunchAgent・通知・<code>~/Library/...</code> の保存先に依存
しています。Windowsでは部分的に動かそうとせず、未対応であることを明示するエラー
で早期終了します。

このツールは、特定のChatGPTプランに5時間枠がある／ないとは仮定しません。サイン
イン中のアカウントについてApp Serverが返した実測スナップショットだけを使います。

- 5時間枠がなくWeekly枠がある場合: 正常です。Weekly枠だけを監視・anchorします。
- 両方の対象枠がある場合: 両方を監視します。近い時刻の候補は、選択された経路の
  1ターンに統合します。
- 対象枠がどちらもない場合: 監視は続けますが、anchorは送信しません。

## インストールと初回設定

まずリポジトリをクローンします。

~~~sh
git clone https://github.com/GrShin5/codex-reset-manager.git
cd codex-reset-manager
~~~

リポジトリのルートで次を実行します。

~~~sh
npm ci
npm run build
node dist/src/cli.js doctor
node dist/src/cli.js install
node dist/src/cli.js test-anchor --confirm-consume-usage
node dist/src/cli.js enable
~~~

<code>install</code> はユーザー単位のLaunchAgentを登録しますが、自動anchorは常に
無効のまま開始します。<code>test-anchor --confirm-consume-usage</code> だけが、
意図的に小さな実Codexターンを使う手動コマンドです。まず安全な経路を検証し、次に
利用できる将来のreset時刻を枠ごとの実行基準として保存します。
<code>verified</code> はターン後に対象枠の時刻が進んだ状態です。
<code>ready</code> はターンが安全に完了し、まだ将来の同一時刻を基準として採用した
状態で、時刻更新の検証は初回自動anchorまで保留であることを表します。どちらも
<code>enable</code> を許可しますが、<code>unverified</code>、
<code>safety_abort</code>、<code>rejected</code> は許可しません。<code>ready</code>
では直ちに自動ターンを開始せず、採用したreset境界と猶予時間の後まで待ちます。
その後も、新しい枠の完全な読み取りでUsageが正確に0%であることを要求します。少しでも
利用が見える場合は、モデルターンで「追い掛け」ず、安全な見送りとして記録します。
<code>ready</code>でEnableできるのは、採用した基準の少なくとも1つがまだ将来時刻の
場合だけです。すべての境界を過ぎた場合は、即時anchorを出さず新しい手動テストを
実行してください。このコマンドは実際に選んだモデル／effortを表示し、次の自動anchor
では、その時点のApp Server一覧から改めて選びます。

## 導入済み環境を更新する

既存のクローンのルートで、ソースを更新・ビルドし、登録済みLaunchAgentを再起動
します。

~~~sh
git pull --ff-only
npm ci
npm run build
node dist/src/cli.js doctor
launchctl kickstart -k gui/$(id -u)/com.codex-reset-manager
node dist/src/cli.js status
~~~

この更新経路は既存の制御状態を保ち、モデルターンも開始しません。ビルド更新だけを
反映するために <code>install</code> を実行しないでください。<code>install</code>
は自動anchorを意図的に無効にします。LaunchAgentが存在しない場合や、記録済みの
Codex CLIパスを変更する必要がある場合だけ <code>install</code> を使い、その後は
<code>status</code> を確認して、新しい明示的な手動検証を行ってから自動anchorを
有効にしてください。

## 正常に動いているか確認する

~~~sh
node dist/src/cli.js status
node dist/src/cli.js logs
node dist/src/cli.js verify-monitoring-cost --reads=20
launchctl print gui/$(id -u)/com.codex-reset-manager
~~~

見方は次の通りです。

- <code>status</code> はLaunchAgent plistの有無、自動anchorの有効状態、手動
  テストの安全／経路結果とreset時刻の結果、採用済み基準、各対象枠を観測済みか、
  次のreset判定時刻、各基準を採用した根拠、手動テストで実際に選んだ経路、選択経路を
  含む直近のanchor世代を表示します。直近の<code>skipped</code>があれば、意図的に
  モデルターンを使わなかった理由も表示します。
- <code>logs</code> は、トークン、認可ヘッダー、cookie、secret、password、メール
  アドレス、リクエスト／レスポンス／prompt／messageの生の内容といった認証情報型の
  値を、フィールド名に基づいて伏せたJSONLイベントを表示します。ローカルの
  ファイルシステムパスは伏せません。ホームディレクトリ名を含む解決済みCodex CLI
  パスもそのまま記録されるため、共有前に出力を確認してください。正常な常駐監視では
  <code>daemon_started</code> と <code>rate_limits_observed</code>、自動anchorでは
  <code>anchor_preflight_observed</code>、<code>anchor_claimed</code> の後に
  <code>anchor_completed</code> が記録されます。モデルターンを出さない安全な判断では、
  理由とともに<code>anchor_skipped</code>が記録されます。
- <code>verified</code> は、隔離した選択経路のターンの後に対象枠の将来reset時刻が
  進んだことを確認できた状態です。<code>ready</code> は手動テスト専用で、安全な
  ターンは完了したものの、将来の同一時刻を最初の実行基準として採用した状態です。
  <code>enable</code> は可能ですが、初回自動anchorで時刻更新を確認できるまで通知も
  完全検証も行いません。<code>unverified</code>、<code>safety_abort</code>、
  <code>rejected</code>、<code>skipped</code> は安全側の非成功結果です。同じreset
  世代への再試行は行いません。後のresetも、完全で適時のスナップショットが次のcycleの
  Usage 0%を証明できる場合だけ候補になります。
- <code>verify-monitoring-cost</code> はpassive read前後の状態を比較します。この
  クライアント経路がモデルターンを開始しない補助確認であり、バックエンドUsageが
  絶対ゼロとは主張しません。
- <code>launchctl print</code> は読み込まれたLaunchAgentが実際に動作中かを確認
  します。<code>CODEX_RESET_MANAGER_CODEX</code> 環境値に絶対CLIパスが入って
  いることも確認できます。<code>status</code> だけではplistファイルの存在確認
  です。

macOS通知は、自動anchorが完了し、対象枠のreset時刻が進んだことを検証できた後に
だけ、1回送ります。内容には実際に選んだモデル／effortと、実際に進んだ枠の名前だけ
を含めます。接続・再接続・スリープ復帰・候補検出・ターン開始・
検証を伴わない完了・検証不能・拒否・安全中断・例外・手動<code>test-anchor</code>
では通知しません。通知の配信に失敗またはハングした場合は5秒で打ち切ります。
anchorの結果には影響せず、失敗はログだけに残します。

## 停止とアンインストール

自動anchorだけを止め、passive monitoringは継続する場合:

~~~sh
node dist/src/cli.js disable
~~~

バックグラウンドのLaunchAgentを解除する場合:

~~~sh
node dist/src/cli.js uninstall
~~~

Terminalで <code>daemon</code> を前面実行していた場合は、そのTerminalで
Control-C も実行して停止してください。安全に止める順序は
<code>disable</code> の後に <code>uninstall</code> です。

<code>uninstall</code> はLaunchAgentを停止し、次のplistだけを削除します。

~~~text
~/Library/LaunchAgents/com.codex-reset-manager.plist
~~~

調査用に、以下のローカルデータは意図的に残します。

~~~text
~/Library/Application Support/Codex Reset Manager/
~~~

このフォルダには <code>state.json</code>、<code>config.json</code>、認証情報型の値を
フィールド名に基づいて伏せる <code>logs/</code>、専用
<code>anchor-workspace/</code> が含まれます。解決済みCodex CLIパスとホーム
ディレクトリ名を含むローカルのファイルシステムパスは伏せないため、ログは共有前に
確認してください。すべてのローカルデータも削除したい場合は、まず
<code>disable</code> と <code>uninstall</code> を実行し、その後この**正確な
フォルダ**をFinderでゴミ箱へ移動してください。ソースやローカルNode依存関係も
不要になった場合だけ、クローンしたリポジトリのフォルダを別途削除してください。

## 環境変数

- <code>CODEX_RESET_MANAGER_CODEX</code> — Codex CLI実行ファイルの絶対パスです。
  <code>install</code> は対話シェルから解決してLaunchAgent plistへ書き込むため、
  バックグラウンド処理はlaunchdの最小限の<code>PATH</code>に依存しません。手動で
  設定すると、この解決結果を上書きします。
- <code>CODEX_ANCHOR_HOME</code> — アプリケーションデータのルートを上書きします
  （既定値: <code>~/Library/Application Support/Codex Reset Manager</code>）。これは
  LaunchAgent plistには書き込まれないため、launchd管理のdaemonは常に既定のルートを
  使用します。対話シェルでexportすると、<code>status</code> と <code>logs</code> は
  daemonの書き込み先とは別のルートを読むため、活動がないように見えます。通常の
  インストール移動用ではなく、テストと隔離実行用です。

## コマンド一覧

| コマンド | 用途 | モデルターンを開始するか |
| --- | --- | --- |
| <code>doctor</code> | CLI、認証、利用可能な候補、Usage枠、ephemeral、通知の前提を診断します。 | いいえ |
| <code>install</code> / <code>uninstall</code> | ユーザー単位LaunchAgentを登録／解除します。 | いいえ |
| <code>daemon</code> | 前面で監視を実行します。 | 有効な境界で、最新の次cycle Usageが0%と確認できた場合だけ |
| <code>status</code> / <code>logs</code> | 記録済み状態とフィールド名に基づき伏せたイベントを確認します。パスはそのままの場合があるため共有前に確認します。 | いいえ |
| <code>enable</code> / <code>disable</code> | 自動anchorを制御します。Enableには<code>verified</code>または将来基準を持つ<code>ready</code>が必要です。 | いいえ |
| <code>verify-monitoring-cost</code> | passive rate-limit readを比較します。 | いいえ |
| <code>test-anchor --confirm-consume-usage</code> | 実際のanchor経路を明示的に検証し、選んだ経路を表示します。 | はい — 最小の選択経路1ターン |

## 開発時の検証

~~~sh
npm run typecheck
npm test
~~~

自動テストは、JSON-RPC相関、疎なrate-limit更新、対象枠の分類（Weeklyのみ／対象枠
なしを含む）、Usage 0%のreset rollover検出、利用あり・遅延rolloverの見送り、集約中の
preflight中止、リセット世代の予約、再起動後の挙動、自動開始通知が1回だけであること、
決定的な経路選択とRPC伝播、ephemeral拒否、tool／approval／reroute中断、ログ、
ロック復旧、macOS限定エラー、実行ファイルパスの解決、LaunchAgent plist検証を
対象にします。fake App Serverを使う統合テストで、代替候補による<code>verified</code>
と<code>ready</code>の手動検証から自動anchorの有効化までを安全に確認し、
<code>unverified</code>では有効化できないことも確認します。実アカウントに対する
<code>test-anchor</code> は実行しません。

## ライセンスと免責

[MIT License](./LICENSE) の下で公開しています。

これは非公式の独立プロジェクトであり、OpenAIとの提携・承認・支援関係はありません。
「Codex」と「ChatGPT」は相互運用性を説明する目的でのみ記載しています。対応する
App Serverインターフェースを通じてご自身のCodexアカウントと連携するため、利用は
自己責任で行ってください。作者は保証、継続的な互換性の保証、サポートを提供しません。
自動anchorを有効にする前に、ソースコードと`doctor`の出力を確認してください。
