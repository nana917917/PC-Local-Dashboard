# 参考にした情報源と、採用しなかった点

この文書は、PC Local Dashboard v0.12 の設計で参考にした外部情報源をまとめたものです。

- 参照日: 2026-09-12（同日に各URLへ接続できることを確認。HTTP 200）
- コードや画像は一切コピーしていません。参考にしたのは「考え方」と「画面の構成」だけです。
- 外部ライブラリは追加していません（画面は自作のCanvas描画、サーバーはNode.js標準機能のみ）。

## 1. Home Assistant（エネルギー管理）

- URL: https://www.home-assistant.io/docs/energy/
- サイト名: Home Assistant（公式ドキュメント「Home energy management」）
- 参考にした点:
  - 日・週・月・年といった期間の集計を最初から用意する考え方
  - 「累積（ずっと積み上がった値）」と「期間内の消費量」を切り替えて見る考え方
  - データが足りない期間は比較結果を出さない、という慎重な扱い
- 採用しなかった点: 家庭内の多数の機器をまとめるダッシュボード編集機能（このツールの目的から外れるため）
- ライセンス上の注意: ドキュメントの文章・画像は転載していません。

- URL: https://www.home-assistant.io/integrations/utility_meter/
- サイト名: Home Assistant（公式ドキュメント「Utility Meter」）
- 参考にした点: 期間ごとに区切って積算する考え方（今回の「期間ごとの料金・電力量」に対応）
- 採用しなかった点: 自動リセットや複数メーターの一括管理（PC1台の記録には不要）

## 2. Grafana（時系列グラフの見せ方）

- URL: https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/time-series/
- サイト名: Grafana Labs（公式ドキュメント「Time series」）
- 参考にした点:
  - グラフへカーソルを合わせたときの詳細表示（日時・平均・最大・電力量・料金）
  - 表示期間の長さに応じて自動で集計の粗さを変える考え方
  - データが無い区間を線でつながない（誤った連続に見せない）
  - グラフだけでなく表でも正確な値を確認できるようにする
- 採用しなかった点: 自由自在にパネルを組み替える機能、クエリ編集画面（操作が複雑になり、この用途には過剰）
- ライセンス上の注意: Grafana本体のコード・画面画像は使用していません。

## 3. Netdata（詳細の掘り下げ方）

- URL: https://learn.netdata.cloud/docs/dashboards-and-charts/expanded-chart-analysis
- サイト名: Netdata（公式ドキュメント「Expanded Chart Analysis」）
- 参考にした点:
  - 最初の画面は概要だけにし、必要なときだけ詳細へ掘り下げる構成
  - 折りたたみ（details）で詳細を隠し、常時すべてを表示しない
- 採用しなかった点: 常時すべてのセンサーを表示する画面、多数のグラフを並べる構成

- URL: https://community.netdata.cloud/t/libre-hardware-monitor-as-collector/3165
- サイト名: Netdata Community Forums（「Libre Hardware Monitor as collector」）
- 参考にした点: 取得できるセンサーと取得できないセンサーが混在する前提で表示を設計する考え方

## 4. Libre Hardware Monitor（センサーの扱い）

- URL: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
- サイト名: GitHub（LibreHardwareMonitor リポジトリ）
- 参考にした点:
  - 温度・ファン・クロックなど、センサーの種類ごとに整理して表示する考え方
  - 取得できない値を0として扱わない、という方針
- 採用しなかった点: 同ツールの同梱・自動導入（新たな常駐ツールと管理者権限が必要になるため）。今回は「未対応」「未取得」として明示するだけにしました。
- ライセンス上の注意: Mozilla Public License 2.0 のソフトウェアです。コードの流用はしていません。

- URL: https://www.home-assistant.io/integrations/libre_hardware_monitor/
- サイト名: Home Assistant（公式ドキュメント「Libre Hardware Monitor」）
- 参考にした点: リモートからPCの状態を見る場合の取得項目の整理
- 採用しなかった点: 外部サーバーへの常時送信（このツールは`127.0.0.1`と家庭内LANのみ）

## 5. 有志の電力記録ツール

- URL: https://github.com/stansebauno/watttracker
- サイト名: GitHub（watttracker リポジトリ）
- 参考にした点:
  - 軽量に記録を続け、後から履歴グラフで振り返る考え方
  - CPU・GPUなど部品ごとの値を並べて見る構成
- 採用しなかった点:
  - アプリ別の電力を「実測」のように見せる表示（このツールでは常に「推定配分」と明示します）
  - 継続的なバックグラウンド記録の自作（計測は既存のWattSealに任せます）
- ライセンス上の注意: リポジトリの内容は参照のみで、コードは使用していません。

## 6. コミュニティの要望傾向

- URL: https://www.reddit.com/r/OctopusEnergy/comments/1kc7jou/electricity_consumption_dashboard/
- サイト名: Reddit（r/OctopusEnergy「Electricity consumption dashboard」）
- 参考にした点: リアルタイム値だけでなく、履歴・期間比較・グラフでの傾向確認が求められるという傾向
- 採用しなかった点: 投稿内容の転載、特定サービスの構成の模倣

## 7. 計測エンジン（既存）

- URL: https://github.com/Daminoup88/WattSeal
- サイト名: GitHub（WattSeal）
- 参考にした点: 内部センサー（CPUのRAPL、GPUのベンダーAPI等）から電力を取得する方式、1秒記録と1時間ごとの平均記録の扱い
- ライセンス上の注意: GPL-3.0。このリポジトリへは同梱せず、セットアップ時に公式配布元から取得してSHA-256で検証します（`THIRD_PARTY_NOTICES.md`参照）。

## 今回の判断（まとめ）

- 採用したもの: 期間と粒度の連動、累積と期間内の切り替え、比較可否の判定、ホバー詳細、数値表、概要と詳細の分離、取得不能の明示、ローカル中心の設計。
- 採用しなかったもの: 自由なダッシュボード編集、常時全センサー表示、外部クラウド同期、アプリ別電力の「実測」表示、複雑な認証、常駐サービスの追加。
- 参考先の文章・画像・コードはコピーしていません。画面の実装はすべてこのプロジェクトの独自コードです。
