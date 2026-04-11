import { MODEL_POLICY_FILE, loadJson, loadOctoClawConfig } from "./config.js";
import { inferRunnerPlaybook } from "./runner_playbooks.js";
import { inferWorkerPool as taxonomyInferWorkerPool } from "./taxonomy.js";

const DEFAULT_ROUTE_LANGUAGE_PACKS = ["zh", "en"];
const OPTIONAL_ROUTE_LANGUAGE_PACKS = ["ja", "ko", "es", "pt", "ru"];
const SUPPORTED_ROUTE_LANGUAGE_PACKS = [...DEFAULT_ROUTE_LANGUAGE_PACKS, ...OPTIONAL_ROUTE_LANGUAGE_PACKS];

const RUNNER_PATTERNS = {
  common: [
    String.raw`\b(curl|grep|rg|tail|head|pwd|ls|find|cat|jq|sed|awk|ss|ps|top|netstat)\b`,
    String.raw`\b(cron|crontab|timer|timers|list-timers)\b`,
  ],
  zh: [String.raw`(日志|端口|版本|环境变量|连通性|健康检查|进程|服务状态|端口监听|磁盘|内存|cpu|负载)`],
  en: [String.raw`\b(log|logs|health|status|version|port|env|headers?|pid|process|uptime)\b`],
  ja: [String.raw`(ログ|ポート|バージョン|環境変数|ヘルスチェック|プロセス|サービス状態|ディスク|メモリ|負荷)`],
  ko: [String.raw`(로그|포트|버전|환경 변수|헬스 체크|프로세스|서비스 상태|디스크|메모리|부하)`],
  es: [String.raw`(registros?|logs?|puerto|versión|variables? de entorno|salud|proceso|estado del servicio|disco|memoria|carga)`],
  pt: [String.raw`(logs?|porta|versão|variáveis? de ambiente|saúde|processo|estado do serviço|disco|memória|carga)`],
  ru: [String.raw`(логи?|порт|версия|переменные окружения|здоровье|процесс|состояние сервиса|диск|память|нагрузка)`],
};

const RUNNER_READ_ONLY_INTENT_PATTERNS = {
  zh: [String.raw`(看下|看一下|看看|查下|查一下|查看|搜一下|搜下|搜索|列出|显示|读取|有没有|确认一下|检查一下|正常吗)`],
  en: [String.raw`\b(check|inspect|show|list|display|read|search|find|look at|verify|confirm)\b`],
  ja: [String.raw`(見て|見せて|確認して|調べて|検索して|一覧|表示して|読んで|あるか)`],
  ko: [String.raw`(확인해|확인해줘|봐줘|보여줘|찾아줘|검색해|읽어줘|있는지)`],
  es: [String.raw`(verifica|comprueba|muestra|lista|lee|busca|encuentra|revisa)`],
  pt: [String.raw`(verifique|confira|mostre|liste|leia|busque|encontre|revise)`],
  ru: [String.raw`(проверь|посмотри|покажи|список|прочитай|найди|поищи|убедись)`],
};

const RUNNER_TARGET_PATTERNS = {
  zh: [String.raw`(日志|端口|进程|状态|文件|目录|环境变量|监听|路径|配置|版本|health|输出|cron|crontab|定时任务|计划任务|timer|timers)`],
  en: [String.raw`\b(log|logs|port|ports|process|pid|status|file|files|directory|directories|env|environment|path|config|version|health|output|cron|crontab|timer|timers|scheduler)\b`],
  ja: [String.raw`(ログ|ポート|プロセス|状態|ファイル|ディレクトリ|環境変数|パス|設定|バージョン|出力)`],
  ko: [String.raw`(로그|포트|프로세스|상태|파일|디렉터리|환경 변수|경로|설정|버전|출력)`],
  es: [String.raw`(log|logs|puerto|proceso|estado|archivo|archivos|directorio|directorios|entorno|ruta|configuración|versión|salida)`],
  pt: [String.raw`(log|logs|porta|processo|estado|arquivo|arquivos|diretório|diretórios|ambiente|caminho|configuração|versão|saída)`],
  ru: [String.raw`(лог|логи|порт|процесс|состояние|файл|файлы|каталог|каталоги|окружение|путь|конфиг|версия|вывод)`],
};

const RUNNER_NEGATIVE_PATTERNS = {
  zh: [String.raw`(修复|修改|改代码|改一下|重构|实现|开发|分析|对比|研究|方案|根因|原因|解释|总结|写文档|写一版|报告|周报|部署|重启|安装|卸载|删除|新增|创建|迁移|权限|密钥|数据库)`],
  en: [String.raw`\b(fix|modify|change|patch|refactor|implement|develop|analy(?:ze|sis)|compare|research|proposal|root cause|cause|reason|explain|summary|summarize|write|report|deploy|restart|install|uninstall|delete|create|add|migrate|permission|secret|database)\b`],
  ja: [String.raw`(修正|変更|コードを変更|リファクタ|実装|開発|分析|比較|調査|提案|根本原因|説明|要約|文書|レポート|デプロイ|再起動|インストール|アンインストール|削除|追加|作成|移行|権限|シークレット|データベース)`],
  ko: [String.raw`(수정|변경|코드 수정|리팩터|구현|개발|분석|비교|조사|제안|근본 원인|설명|요약|문서|보고서|배포|재시작|설치|삭제|추가|생성|마이그레이션|권한|시크릿|데이터베이스)`],
  es: [String.raw`(arregla|corrige|modifica|cambia|refactoriza|implementa|desarrolla|analiza|compara|investiga|propuesta|causa raíz|explica|resume|documenta|informe|despliega|reinicia|instala|desinstala|elimina|agrega|crea|migra|permisos|secreto|base de datos)`],
  pt: [String.raw`(corrija|conserte|modifique|mude|refatore|implemente|desenvolva|analise|compare|pesquise|proposta|causa raiz|explique|resuma|documente|relatório|implante|reinicie|instale|desinstale|exclua|adicione|crie|migre|permissão|segredo|banco de dados)`],
  ru: [String.raw`(исправь|почини|измени|модифицируй|рефактор|реализуй|разработай|проанализируй|сравни|исследуй|предложение|первопричина|объясни|суммируй|документ|отч[её]т|задеплой|перезапусти|установи|удали|добавь|создай|миграц|разрешени|секрет|база данных)`],
};

const MODEL_BENCHMARK_PATTERNS = {
  zh: [
    String.raw`(首\s*token|首token|首字延迟|首包延迟|首包|吞吐|tokens/s|token/s|tps|ttft|throughput|输出速度|响应速度)`,
    String.raw`(测速|测一下速度|测下速度|测性能|速度对比|模型测速|模型速度|延迟对比)`,
  ],
  en: [String.raw`\b(first token|ttft|throughput|tokens/s|token/s|tps|latency|model speed|speed test|benchmark)\b`],
};

const READ_ONLY_COMMAND_PATTERNS = [
  String.raw`^\s*(grep|rg|tail|head|pwd|ls|find|cat|jq|awk|ss|ps|top|netstat|lsof)\b`,
  String.raw`^\s*sed\b(?!.*\s-i\b)`,
  String.raw`^\s*curl\b(?!.*(?:\s-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|--data\b|--data-raw\b|--form\b))`,
];

const WRITE_COMMAND_PATTERNS = [
  String.raw`\b(rm|mv|cp|tee|truncate|touch|mkdir|rmdir|chmod|chown)\b`,
  String.raw`\bsed\s+-i\b`,
  String.raw`\b(systemctl|service)\s+(restart|start|stop|reload)\b`,
  String.raw`\b(kubectl|docker)\s+(apply|delete|restart|rm|run|exec)\b`,
  String.raw`\b(apt|yum|dnf|brew|pip|npm|pnpm|yarn)\s+(install|remove|uninstall|upgrade|update)\b`,
];

const CODE_PATTERNS = {
  zh: [String.raw`(写代码|改代码|修改代码|修复|bug|重构|实现|开发|review|评审|测试|回归)`],
  en: [String.raw`\b(code|coding|fix|bug|refactor|implement|patch|review|test|pytest|regression)\b`],
  ja: [String.raw`(コード|バグ|リファクタ|実装|レビュー|テスト|回帰)`],
  ko: [String.raw`(코드|버그|리팩터|구현|리뷰|테스트|회귀)`],
  es: [String.raw`(código|bug|error|refactoriza|implementa|revisión|prueba|regresión)`],
  pt: [String.raw`(código|bug|erro|refatore|implemente|revisão|teste|regressão)`],
  ru: [String.raw`(код|баг|ошибк|рефактор|реализуй|ревью|тест|регресс)`],
};

const RESEARCH_PATTERNS = {
  zh: [
    String.raw`(调研|对比|分析|研究|根因|方案|api|数据源|可行性)`,
    String.raw`((github|gitlab|仓库|repo|repository).*(commit|release|tag|pr|mr|issue|更新)|((commit|release|tag|pr|mr|issue|更新).*(github|gitlab|仓库|repo|repository)))`,
    String.raw`((项目|仓库).*(提交|改了啥|改了什么|变更)|((提交|改了啥|改了什么|变更).*(项目|仓库)))`,
  ],
  en: [
    String.raw`\b(research|compare|analy|investigate|root cause|api|datasource|feasibility)\b`,
    String.raw`\b((github|gitlab|repo|repository)\b.*\b(commit|release|tag|pull request|pr|issue|updates?)\b|(\bcommit|release|tag|pull request|pr|issue|updates?\b).*\b(github|gitlab|repo|repository))`,
  ],
  ja: [String.raw`(調査|比較|分析|研究|根本原因|提案|実現可能性)`],
  ko: [String.raw`(조사|비교|분석|연구|근본 원인|제안|타당성)`],
  es: [String.raw`(investiga|compara|analiza|investigación|causa raíz|factibilidad)`],
  pt: [String.raw`(pesquise|compare|analise|pesquisa|causa raiz|viabilidade)`],
  ru: [String.raw`(исследуй|сравни|проанализируй|анализ|первопричина|осуществимость)`],
};

const EXTERNAL_LOOKUP_PATTERNS = {
  zh: [
    String.raw`(天气|花粉|汇率|航班|酒店|机票|新闻|价格|行情|官网|接口文档|文档链接)`,
    String.raw`((github|gitlab|仓库|repo|repository).*(commit|release|tag|pr|mr|issue|更新)|((commit|release|tag|pr|mr|issue|更新).*(github|gitlab|仓库|repo|repository)))`,
    String.raw`((今天|今日|最近).*(有更新吗|有没有更新|更新了什么)|((有更新吗|有没有更新|更新了什么).*(github|gitlab|仓库|repo|repository)))`,
    String.raw`((项目|仓库).*(提交|改了啥|改了什么|变更)|((提交|改了啥|改了什么|变更).*(项目|仓库)))`,
  ],
  en: [
    String.raw`\b(weather|pollen|exchange rate|flight|hotel|price|news|official docs?|documentation)\b`,
    String.raw`\b((github|gitlab|repo|repository)\b.*\b(commit|release|tag|pull request|pr|issue|updates?)\b|(\bcommit|release|tag|pull request|pr|issue|updates?\b).*\b(github|gitlab|repo|repository))`,
    String.raw`\b(any|latest|recent|today'?s)\s+updates?\b.*\b(github|gitlab|repo|repository)\b`,
  ],
};

const WRITE_PATTERNS = {
  zh: [String.raw`(文档|总结|报告|草稿|说明|翻译|写一篇|写一版|建议书|建议稿|写.*建议)`],
  en: [String.raw`\b(doc|docs|summary|report|draft|write|translate)\b`],
  ja: [String.raw`(ドキュメント|要約|レポート|下書き|説明|翻訳|書いて)`],
  ko: [String.raw`(문서|요약|보고서|초안|설명|번역|작성해)`],
  es: [String.raw`(documento|resumen|informe|borrador|explicación|traducción|escribe)`],
  pt: [String.raw`(documento|resumo|relatório|rascunho|explicação|tradução|escreva)`],
  ru: [String.raw`(документ|сводк|отч[её]т|черновик|описание|перевод|напиши)`],
};

const SUMMARY_OUTPUT_PATTERNS = {
  zh: [String.raw`(一句总结|三行总结|简短总结|简单总结|给我一句|给我三行|最后总结|最后给一句总结)`],
  en: [String.raw`\b(one-line summary|three-line summary|brief summary|short summary)\b`],
};

const MULTI_STEP_PATTERNS = {
  zh: [String.raw`(先.*再|然后|最后|并给出|顺便|同时需要|分别|先查.*再)`],
  en: [String.raw`\b(first.*then|then|finally|also|and give|meanwhile|in parallel)\b`],
};

const PARALLEL_PATTERNS = {
  zh: [String.raw`(并行|同时|分别处理|一边.*一边)`],
  en: [String.raw`\b(parallel|simultaneous|separately)\b`],
};

const HIGH_RISK_PATTERNS = {
  zh: [
    String.raw`(支付|认证|鉴权|登录|数据库|迁移|权限|安全)`,
    String.raw`((生产环境|线上环境|正式环境).*(发布|上线|变更)|(发布|上线).*(生产环境|线上环境|正式环境))`,
  ],
  en: [
    String.raw`\b(payment|auth|authentication|login|database|migration|permission|security)\b`,
    String.raw`\b((prod|production)\s+(deploy|release|rollout|change)|release\s+to\s+(prod|production)|deploy\s+to\s+(prod|production)|production\s+release)\b`,
  ],
  ja: [String.raw`(本番環境|本番リリース|本番デプロイ|認証|権限|データベース|マイグレーション|セキュリティ|ログイン)`],
  ko: [String.raw`(운영 환경|프로덕션 릴리스|프로덕션 배포|인증|권한|데이터베이스|마이그레이션|보안|로그인)`],
  es: [String.raw`(autenticación|permisos|base de datos|migración|seguridad|inicio de sesión|despliegue a producción|release a producción)`],
  pt: [String.raw`(autenticação|permissão|banco de dados|migração|segurança|login|deploy em produção|release em produção)`],
  ru: [String.raw`(продакшн|релиз в прод|деплой в прод|аутентификац|разрешени|база данных|миграц|безопасност|логин)`],
};

const SIMPLE_DIRECT_PATTERNS = {
  zh: [String.raw`(是什么|什么意思|解释一下|简单说说|怎么理解)`],
  en: [String.raw`\b(what is|explain|summarize|meaning)\b`],
  ja: [String.raw`(とは|意味|説明して|簡単に教えて)`],
  ko: [String.raw`(무엇|무슨 뜻|설명해줘|간단히 설명)`],
  es: [String.raw`(qué es|qué significa|explica|resume)`],
  pt: [String.raw`(o que é|o que significa|explique|resuma)`],
  ru: [String.raw`(что такое|что значит|объясни|кратко опиши)`],
};

const PRODUCT_HELP_PATTERNS = {
  zh: [String.raw`(怎么用|如何使用|用法|使用方法|命令怎么写|命令是什么|备份工具|备份命令|backup\s*(tool|command|usage)?)`],
  en: [String.raw`\b(how to use|usage|backup tool|backup command|command usage|cli usage)\b`],
};

const LOCAL_STATE_PATTERNS = {
  zh: [String.raw`(这台机器|本机|服务器|机器上|当前机器|当前环境|本地环境|系统状态)`],
  en: [String.raw`\b(this machine|host|server|local env|current machine|system status)\b`],
  ja: [String.raw`(このマシン|このサーバー|ローカル環境|現在のマシン|システム状態)`],
  ko: [String.raw`(이 머신|이 서버|로컬 환경|현재 머신|시스템 상태)`],
  es: [String.raw`(esta máquina|este servidor|entorno local|máquina actual|estado del sistema)`],
  pt: [String.raw`(esta máquina|este servidor|ambiente local|máquina atual|estado do sistema)`],
  ru: [String.raw`(эта машина|этот сервер|локальное окружение|текущая машина|состояние системы)`],
};

const VERIFY_PATTERNS = {
  zh: [String.raw`(验证|确认|检查结果|回归|复现|复查|再看一下)`],
  en: [String.raw`\b(verify|validation|regression|confirm|reproduce|double check)\b`],
  ja: [String.raw`(検証|確認|再確認|回帰|再現|もう一度見て)`],
  ko: [String.raw`(검증|확인|재확인|회귀|재현|다시 봐줘)`],
  es: [String.raw`(verifica|validación|regresión|confirma|reproduce|revisa de nuevo)`],
  pt: [String.raw`(verifique|validação|regressão|confirme|reproduza|revise novamente)`],
  ru: [String.raw`(проверь|валидац|регресс|подтверди|воспроизведи|посмотри ещё раз)`],
};

const IMPLEMENT_PATTERNS = {
  zh: [String.raw`(实现|落地|接入|修复|改一下|补上|生成代码|写脚本)`],
  en: [String.raw`\b(implement|integrate|fix|patch|write code|script)\b`],
  ja: [String.raw`(実装|導入|統合|修正|補って|コードを書いて|スクリプトを書いて)`],
  ko: [String.raw`(구현|도입|통합|수정|보완|코드 작성|스크립트 작성)`],
  es: [String.raw`(implementa|integra|corrige|parchea|escribe código|script)`],
  pt: [String.raw`(implemente|integre|corrija|patch|escreva código|script)`],
  ru: [String.raw`(реализуй|интегрируй|исправь|патч|напиши код|скрипт)`],
};

const MUTATION_PATTERNS = {
  zh: [
    String.raw`(修改|改成|改为|更新|删除|新增|创建|写入|替换|迁移|重启|部署|安装|卸载|启用|禁用|调整)`,
    String.raw`(改cron|改配置|改任务|改脚本|改服务|更新配置|修改配置|修改任务|修改服务)`,
    String.raw`(触发并回读|更新并验证|改后验证|修后验证|重启并验证)`,
  ],
  en: [
    String.raw`\b(modify|change|update|delete|add|create|replace|migrate|restart|deploy|install|uninstall|enable|disable|tune)\b`,
    String.raw`\b(update cron|change cron|modify cron|update config|modify config|change config|update service|modify service)\b`,
  ],
  ja: [String.raw`(変更|更新|削除|追加|作成|書き込み|置換|移行|再起動|デプロイ|インストール|有効化|無効化|調整)`],
  ko: [String.raw`(변경|업데이트|삭제|추가|생성|교체|마이그레이션|재시작|배포|설치|활성화|비활성화|조정)`],
  es: [String.raw`(modifica|cambia|actualiza|elimina|agrega|crea|reemplaza|migra|reinicia|despliega|instala|desinstala|habilita|deshabilita|ajusta)`],
  pt: [String.raw`(modifique|mude|atualize|exclua|adicione|crie|substitua|migre|reinicie|implante|instale|desinstale|habilite|desabilite|ajuste)`],
  ru: [String.raw`(измени|обнови|удали|добавь|создай|замени|мигрируй|перезапусти|задеплой|установи|включи|выключи|настрой)`],
};

const COST_SENSITIVE_PATTERNS = {
  zh: [String.raw`(省钱|低成本|便宜点|别太贵)`],
  en: [String.raw`\b(cost|cheap|budget|save money)\b`],
};

const SEMANTIC_AMBIGUITY_PATTERNS = {
  zh: [String.raw`(顺手|顺便|一起|同时帮我|看看要不要|必要时|如果需要|最好|更稳的方案)`],
  en: [String.raw`\b(if needed|if necessary|also help|at the same time|better approach|safer approach)\b`],
};

const CONTINUATION_PATTERNS = {
  zh: [String.raw`(继续|接着|下一步|再查一下|再看一下|再确认一下|顺手补|顺手加|补一下|补个测试|继续处理|继续推进)`],
  en: [String.raw`\b(continue|follow[- ]?up|next step|check again|look again|verify again|add tests|follow through)\b`],
  ja: [String.raw`(続けて|次のステップ|もう一度見て|もう一度確認|テストを追加|続けて進めて)`],
  ko: [String.raw`(계속|다음 단계|다시 확인|다시 봐줘|테스트 추가|계속 진행)`],
  es: [String.raw`(continúa|siguiente paso|revisa de nuevo|verifica de nuevo|agrega pruebas|sigue)`],
  pt: [String.raw`(continue|próximo passo|verifique novamente|revise novamente|adicione testes|siga)`],
  ru: [String.raw`(продолжай|следующий шаг|проверь ещё раз|посмотри ещё раз|добавь тесты|продолжи)`],
};

const ACK_FOLLOWUP_PATTERNS = {
  zh: [String.raw`^(好|好的|好啊|好呀|行|行吧|可以|可以的|继续|继续吧|开始吧|就这样|照这个来|按这个来|没问题)[!！。.，,\s]*$`],
  en: [String.raw`^(ok|okay|sounds good|go ahead|do it|please continue|continue|works for me|sgtm|looks good)[!.,\s]*$`],
  ja: [String.raw`^(はい|了解|お願いします|続けて|そのままで|これでいきましょう)[!！。\s]*$`],
  ko: [String.raw`^(좋아|좋아요|좋습니다|계속해|진행해|그대로 해줘|이대로 가자)[!！。\s]*$`],
  es: [String.raw`^(vale|ok|de acuerdo|adelante|continúa|sigue así)[!.,\s]*$`],
  pt: [String.raw`^(ok|certo|beleza|pode seguir|continue|vai em frente)[!.,\s]*$`],
  ru: [String.raw`^(ок|хорошо|ладно|давай|продолжай|можно продолжать)[!.,\s]*$`],
};

const REMOTE_TARGET_PATTERNS = {
  zh: [String.raw`(远程|另一台机器|另一台主机|另一台机子|目标机器|目标主机|远端)`],
  en: [String.raw`\b(remote|another host|another machine|target host|remote host)\b`, String.raw`(macmini|mac mini)`],
  ja: [String.raw`(リモート|別のマシン|別のホスト|対象ホスト)`],
  ko: [String.raw`(원격|다른 머신|다른 호스트|대상 호스트)`],
  es: [String.raw`(remoto|otra máquina|otro host|host de destino)`],
  pt: [String.raw`(remoto|outra máquina|outro host|host de destino)`],
  ru: [String.raw`(удал[её]нн|другая машина|другой хост|целевой хост)`],
};

const OBSERVER_CONTROL_PATTERNS = {
  zh: [String.raw`(八爪鱼状态|八爪鱼队列|八爪鱼面板|任务详情|任务时间线|任务图|任务结果|任务产物|任务报告|收件箱|队列面板|任务停止|任务重试|任务批准|任务拒绝)`],
  en: [String.raw`\b(octoclaw status|octoclaw queue|task details|task timeline|task graph|task retrieve|task result|task artifacts|task report|task stop|task retry|task approve|task reject|runtime status|task inbox)\b`],
};

const TASK_PROGRESS_PATTERNS = {
  zh: [String.raw`(好了吗|好了没|完了吗|完成了吗|处理完了吗|跑完了吗|还在跑吗|有进展吗|进度(?:怎么样|如何)?|任务(?:进度|状态)|现在(?:什么状态|到哪步了)|还没好吗|(?:single|spawn|runner)\s*成功了吗|还在\s*queued\s*吗|还在排队吗|跑了没|跑起来了吗|完成了没)`],
  en: [String.raw`\b(is it done|done yet|finished yet|still running|any progress|task status|task progress|what(?:'s| is) the status|how(?:'s| is) it going|where are we at)\b`],
};

const WORKFLOW_META_PATTERNS = {
  zh: [
    String.raw`(你是啥模型|你是什么模型|现在啥模型|当前啥模型|现在啥model|当前啥model)`,
    String.raw`(你现在是啥模型|你现在是什么模型|现在是啥模型|现在是什么模型|当前是啥模型|当前是什么模型|现在用的啥模型|现在用的什么模型|当前用的啥模型|当前用的什么模型)`,
    String.raw`(主会话模型|策略主链|主链漂移|子任务模型|当前路由|现在走的是什么路由|这次走的是什么路由)`,
    String.raw`(刚才(那次|这个)?(查询|问题|任务)?是子任务做的吗|刚才(那次|这个)?(查询|问题|任务)?是不是子任务做的|是不是子任务做的|是不是主会话自己查的|是不是主agent自己查的)`,
    String.raw`(你是怎么查的|咋查的|如何查的|用什么查的|怎么查到的)`,
    String.raw`(刚才那个任务那个判定是啥|刚才那个任务判定是啥|刚才任务那个判定是啥|不是\s*runner\s*吗|是不是\s*runner|是不是\s*spawn_single|是不是\s*single)`,
    String.raw`(刚才\s*(single|spawn|runner)\s*成功了吗|刚才那个\s*(single|spawn|runner)\s*成功了吗|那个\s*single怎么样了|那个任务怎么样了|还在\s*queued\s*吗|还在排队吗)`,
    String.raw`(谁查的|谁做的|谁回的|是谁处理的|谁执行的|啥模型做的|什么模型做的|是谁用什么模型做的)`,
    String.raw`(有没有走\s*(dispatch|路由|router)|走了\s*(dispatch|路由|router)\s*吗|有没有走\s*octoclaw_dispatch|判定了\s*direct\s*吗|是不是\s*direct|是不是走了\s*direct|是不是委派了|有没有委派)`,
  ],
  en: [
    String.raw`\b(what model are you (?:on|using) now|current model|which model are you (?:on|using)|main session model|policy primary model|drifted model)\b`,
    String.raw`\b(was this delegated|was this a subtask|did this go through dispatch|did router choose direct|what route was chosen|current route|who handled this|who answered this|who ran this)\b`,
    String.raw`\b(how did you check|how was this checked|what tool did you use|was this runner|was this spawn(?:_single)?|did the single succeed|is it still queued)\b`,
  ],
};

const SESSION_CONTROL_PATTERNS = {
  zh: [
    String.raw`(切换|切到|换到|换成|改成|改到|切换模型|切模型|换模型).{0,32}(mini\s*max|minimax|glm|gpt|claude|qwen|kimi|deepseek|gemini|sonnet|opus|m2\.7|5\.1|4\.7)`,
    String.raw`(把(当前|现在)?模型(切到|换成|改成)).{0,32}(mini\s*max|minimax|glm|gpt|claude|qwen|kimi|deepseek|gemini|sonnet|opus|m2\.7|5\.1|4\.7)`,
  ],
  en: [
    String.raw`\b(switch|change|set)\b.{0,32}\b(model|mini\s*max|minimax|glm|gpt|claude|qwen|kimi|deepseek|gemini|sonnet|opus)\b`,
  ],
};

const ROUTE_PATTERN_LIBRARY = {
  RUNNER_PATTERNS,
  RUNNER_READ_ONLY_INTENT_PATTERNS,
  RUNNER_TARGET_PATTERNS,
  RUNNER_NEGATIVE_PATTERNS,
  CODE_PATTERNS,
  RESEARCH_PATTERNS,
  EXTERNAL_LOOKUP_PATTERNS,
  WRITE_PATTERNS,
  SUMMARY_OUTPUT_PATTERNS,
  MULTI_STEP_PATTERNS,
  PARALLEL_PATTERNS,
  HIGH_RISK_PATTERNS,
  SIMPLE_DIRECT_PATTERNS,
  PRODUCT_HELP_PATTERNS,
  LOCAL_STATE_PATTERNS,
  VERIFY_PATTERNS,
  IMPLEMENT_PATTERNS,
  MUTATION_PATTERNS,
  COST_SENSITIVE_PATTERNS,
  SEMANTIC_AMBIGUITY_PATTERNS,
  CONTINUATION_PATTERNS,
  ACK_FOLLOWUP_PATTERNS,
  REMOTE_TARGET_PATTERNS,
  OBSERVER_CONTROL_PATTERNS,
  TASK_PROGRESS_PATTERNS,
  WORKFLOW_META_PATTERNS,
  SESSION_CONTROL_PATTERNS,
  MODEL_BENCHMARK_PATTERNS,
};

const MODEL_REFERENCE_REGEX = /(?:[a-z0-9_.-]+\/[a-z0-9_.-]+|(?:gpt|glm|minimax|claude|qwen|kimi|deepseek|gemini|sonnet|opus)[-a-z0-9_.]*)/giu;

const languagePatternCache = new Map();

function roundTo(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function toPythonLikeBoundaryPattern(pattern) {
  let normalized = String(pattern || "");
  normalized = normalized.replace(/^\\b(?=\()/u, String.raw`(?<![\p{L}\p{N}_])`);
  normalized = normalized.replace(/\\b$/u, String.raw`(?![\p{L}\p{N}_])`);
  return normalized;
}

function countMatches(text, patterns) {
  return (patterns || []).reduce((count, pattern) => {
    try {
      return count + (new RegExp(toPythonLikeBoundaryPattern(pattern), "iu").test(text) ? 1 : 0);
    } catch {
      return count;
    }
  }, 0);
}

function countModelReferenceHits(text) {
  const normalized = String(text || "").toLowerCase();
  const matches = normalized.match(MODEL_REFERENCE_REGEX) || [];
  return new Set(matches.map((item) => String(item || "").trim()).filter((item) => item.length >= 5)).size;
}

export function normalizeEnabledLanguagePacks(runtimeCfg = null) {
  const packsCfg = runtimeCfg?.route_language_packs && typeof runtimeCfg.route_language_packs === "object"
    ? runtimeCfg.route_language_packs
    : {};
  const rawEnabled = Array.isArray(packsCfg.enabled) ? packsCfg.enabled : DEFAULT_ROUTE_LANGUAGE_PACKS;
  const enabled = [];
  for (const item of rawEnabled) {
    const pack = String(item || "").trim().toLowerCase();
    if (SUPPORTED_ROUTE_LANGUAGE_PACKS.includes(pack) && !enabled.includes(pack)) {
      enabled.push(pack);
    }
  }
  return enabled.length > 0 ? enabled : [...DEFAULT_ROUTE_LANGUAGE_PACKS];
}

function resolveLanguagePatterns(name, enabledPacks) {
  const cacheKey = `${name}:${enabledPacks.join(",")}`;
  if (languagePatternCache.has(cacheKey)) return languagePatternCache.get(cacheKey);
  const patternsByPack = ROUTE_PATTERN_LIBRARY[name] || {};
  const resolved = [...(patternsByPack.common || [])];
  for (const pack of enabledPacks) {
    resolved.push(...(patternsByPack[pack] || []));
  }
  languagePatternCache.set(cacheKey, resolved);
  return resolved;
}

function commandLooksReadOnly(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (WRITE_COMMAND_PATTERNS.some((pattern) => new RegExp(pattern, "iu").test(cmd))) return false;
  return READ_ONLY_COMMAND_PATTERNS.some((pattern) => new RegExp(pattern, "iu").test(cmd));
}

function normalizeConversationControlMetadata(metadata = {}) {
  const raw = metadata?.conversation_control;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...raw };
}

function inferLookupProject(task = "") {
  const text = String(task || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("openclaw")) return "openclaw";
  if (text.includes("octoclaw")) return "octoclaw";
  return "";
}

function inferLookupFocus(task = "") {
  const text = String(task || "").trim();
  if (!text) return "";
  if (/(memory|dream|diary|rem)/iu.test(text)) return "memory";
  if (/(release|发版|版本|更新|changelog|特性|变化|what'?s new)/iu.test(text)) return "release_updates";
  return "latest_updates";
}

export function extractFeatures(task, command = "", runtimeCfg = null, metadata = {}) {
  const rawTask = String(task || "").trim();
  const text = rawTask.toLowerCase();
  const normalizedCommand = String(command || "").trim();
  const enabledPacks = normalizeEnabledLanguagePacks(runtimeCfg);
  const conversationControl = normalizeConversationControlMetadata(metadata);
  const intentPacket = metadata?.intent_packet && typeof metadata.intent_packet === "object" && !Array.isArray(metadata.intent_packet)
    ? metadata.intent_packet
    : {};
  const intentSignals = intentPacket?.signals && typeof intentPacket.signals === "object" && !Array.isArray(intentPacket.signals)
    ? intentPacket.signals
    : {};
  const signalSurfaceMentions = Array.isArray(intentSignals.surface_mentions)
    ? intentSignals.surface_mentions.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const intentPacketAvailable = Boolean(intentPacket && typeof intentPacket === "object" && !Array.isArray(intentPacket) && intentPacket.available !== false);
  const signalLocalSurfaceLookup = !intentPacketAvailable && signalSurfaceMentions.length > 0;
  const intentClass = String(conversationControl.intent_class || intentPacket.intent_class || "").trim();
  const intentLookup = intentPacket?.lookup && typeof intentPacket.lookup === "object" && !Array.isArray(intentPacket.lookup)
    ? intentPacket.lookup
    : {};
  const conversationLookupScope = String(conversationControl.lookup_scope || intentLookup.scope || "").trim();
  const conversationLookupProject = String(conversationControl.lookup_project || intentLookup.project || "").trim();
  const conversationLookupFocus = String(conversationControl.lookup_focus || intentLookup.focus || "").trim();
  const conversationKind = String(conversationControl.kind || intentClass || "").trim();
  const explicitPortProbe = Boolean(
    /\d{2,5}\s*(?:端口|port)/u.test(text)
      || /\d{2,5}.{0,8}ポート/u.test(text),
  );
  let explicitLocalProbe = Boolean(
    /\/[A-Za-z0-9._/\-]+/.test(rawTask)
      || /(?:最近|近)\s*\d{1,4}\s*行/u.test(rawTask)
      || /\btail\s+-n?\s*\d{1,4}\b/u.test(text)
      || explicitPortProbe,
  );

  const runnerHits = countMatches(text, resolveLanguagePatterns("RUNNER_PATTERNS", enabledPacks));
  const codeHits = countMatches(text, resolveLanguagePatterns("CODE_PATTERNS", enabledPacks));
  const researchHits = countMatches(text, resolveLanguagePatterns("RESEARCH_PATTERNS", enabledPacks));
  const externalLookupHits = countMatches(text, resolveLanguagePatterns("EXTERNAL_LOOKUP_PATTERNS", enabledPacks));
  const writeHits = countMatches(text, resolveLanguagePatterns("WRITE_PATTERNS", enabledPacks));
  const summaryOutputHits = countMatches(text, resolveLanguagePatterns("SUMMARY_OUTPUT_PATTERNS", enabledPacks));
  const multiStepHits = countMatches(text, resolveLanguagePatterns("MULTI_STEP_PATTERNS", enabledPacks));
  const parallelHits = countMatches(text, resolveLanguagePatterns("PARALLEL_PATTERNS", enabledPacks));
  const highRiskHits = countMatches(text, resolveLanguagePatterns("HIGH_RISK_PATTERNS", enabledPacks));
  const simpleHits = countMatches(text, resolveLanguagePatterns("SIMPLE_DIRECT_PATTERNS", enabledPacks));
  const productHelpHits = countMatches(text, resolveLanguagePatterns("PRODUCT_HELP_PATTERNS", enabledPacks));
  const localStateHits = countMatches(text, resolveLanguagePatterns("LOCAL_STATE_PATTERNS", enabledPacks));
  const verifyHits = countMatches(text, resolveLanguagePatterns("VERIFY_PATTERNS", enabledPacks));
  const implementHits = countMatches(text, resolveLanguagePatterns("IMPLEMENT_PATTERNS", enabledPacks));
  const mutationHits = countMatches(text, resolveLanguagePatterns("MUTATION_PATTERNS", enabledPacks));
  const costSensitiveHits = countMatches(text, resolveLanguagePatterns("COST_SENSITIVE_PATTERNS", enabledPacks));
  const semanticAmbiguityHits = countMatches(text, resolveLanguagePatterns("SEMANTIC_AMBIGUITY_PATTERNS", enabledPacks));
  const continuationHits = countMatches(text, resolveLanguagePatterns("CONTINUATION_PATTERNS", enabledPacks));
  const ackFollowupHits = countMatches(text, resolveLanguagePatterns("ACK_FOLLOWUP_PATTERNS", enabledPacks));
  const remoteTargetHits = countMatches(text, resolveLanguagePatterns("REMOTE_TARGET_PATTERNS", enabledPacks));
  const runnerReadOnlyIntentHits = countMatches(text, resolveLanguagePatterns("RUNNER_READ_ONLY_INTENT_PATTERNS", enabledPacks));
  const runnerTargetHits = countMatches(text, resolveLanguagePatterns("RUNNER_TARGET_PATTERNS", enabledPacks));
  const runnerNegativeHits = countMatches(text, resolveLanguagePatterns("RUNNER_NEGATIVE_PATTERNS", enabledPacks));
  const observerControlHits = countMatches(text, resolveLanguagePatterns("OBSERVER_CONTROL_PATTERNS", enabledPacks));
  const taskProgressHits = countMatches(text, resolveLanguagePatterns("TASK_PROGRESS_PATTERNS", enabledPacks));
  const workflowMetaHits = countMatches(text, resolveLanguagePatterns("WORKFLOW_META_PATTERNS", enabledPacks));
  const sessionControlHits = countMatches(text, resolveLanguagePatterns("SESSION_CONTROL_PATTERNS", enabledPacks));
  const modelBenchmarkHits = countMatches(text, resolveLanguagePatterns("MODEL_BENCHMARK_PATTERNS", enabledPacks));
  const modelReferenceHits = countModelReferenceHits(text);
  const taskCommandReadOnly = !normalizedCommand && commandLooksReadOnly(rawTask);
  const commandReadOnly = commandLooksReadOnly(normalizedCommand) || taskCommandReadOnly;
  const explicitObserverCommand = Boolean(
    /^\s*(?:八爪鱼状态|八爪鱼队列|八爪鱼面板)\s*$/iu.test(rawTask)
      || /^\s*(?:queue|inbox)\s*$/iu.test(rawTask)
      || /^\s*(?:details?|view|retrieve|result|graph|timeline|artifacts?|stop|retry|approve|reject)\s+[A-Za-z0-9._:/-]+\s*$/iu.test(rawTask)
      || /^\s*(?:任务详情|任务时间线|任务图|任务结果|任务产物|任务报告|任务停止|任务重试|任务批准|任务拒绝)\s+[A-Za-z0-9._:/-]+\s*$/iu.test(rawTask),
  );
  let workflowMetaCandidate = workflowMetaHits > 0;
  let sessionControlCandidate = Boolean(sessionControlHits > 0);
  const modelBenchmarkCandidate = Boolean(modelBenchmarkHits > 0 && modelReferenceHits > 0 && !workflowMetaCandidate && !sessionControlCandidate);
  const runtimeVersionLookup = Boolean(
    !intentPacketAvailable
    && (
    signalSurfaceMentions.includes("runtime_version")
    || (
      !/(模型|model)/iu.test(text)
      && !/(新版本|更新|发版|release|changelog|新特性|特性|变化|memory|dream|what'?s new|latest|recent)/iu.test(text)
      && (
      /(openclaw|octoclaw).*(版本|version)/iu.test(rawTask)
      || /(现在|当前).*(啥版本|什么版本|版本|version)/iu.test(rawTask)
      || /^\s*(?:你现在啥版本|你现在是什么版本|当前.*版本|what version are you|current version)\s*$/iu.test(rawTask)
      )
    )
    )
  );

  const repoActivityLookup = Boolean(
    !intentPacketAvailable
    && (
    (
      /(github|gitlab|仓库|repo|repository|项目)/iu.test(text)
      && /(commit|release|tag|pr|mr|issue|更新|提交|改了啥|改了什么|变更)/iu.test(text)
      && /(有没有|有更新吗|更新了什么|今天|今日|最近|latest|recent|today|updates?)/iu.test(text)
    )
    || (
      /(项目|仓库)/iu.test(text)
      && /(提交|改了啥|改了什么|变更)/iu.test(text)
    )
    )
  );
  const boundedSoftwareUpdateLookup = Boolean(
    !intentPacketAvailable
    && (
    /(openclaw|octoclaw)/iu.test(text)
    && /(有啥更新|有什么更新|更新了什么|最近.*更新|最新.*更新|最新.*release|新版本|release|新的?发版|最新发版|最近发版|memory方向|特性|变化)/iu.test(text)
    && !/(改了啥|改了什么|提交|commit|pr|issue|详细|分析|总结|报告|写一版|release analysis|commit summary|summari[sz]e)/iu.test(rawTask)
    )
  );
  const boundedRepoUpdateLookup = Boolean(
    (repoActivityLookup || boundedSoftwareUpdateLookup)
    && !/(改了啥|改了什么|都有啥提交|今天都有啥提交|提交明细|详细变更|分析|总结|release|报告|写一版|recommend|analysis|what changed|commit summary|summari[sz]e commits?|release analysis)/iu.test(rawTask)
    && multiStepHits === 0
    && summaryOutputHits === 0
    && writeHits === 0
  );
  const freshLiveLookupCandidate = Boolean(intentClass === "fresh_live_lookup" || boundedRepoUpdateLookup);
  const localProductHelpLookup = Boolean(
    productHelpHits > 0
    && /(open\s*claw|openclaw|octo\s*claw|octoclaw)/iu.test(rawTask)
    && !freshLiveLookupCandidate
    && !boundedSoftwareUpdateLookup
    && !repoActivityLookup
  );
  const resolvedLookupProject = conversationLookupProject || (
    (freshLiveLookupCandidate || runtimeVersionLookup) ? inferLookupProject(rawTask) : ""
  );
  const resolvedLookupFocus = conversationLookupFocus || (
    freshLiveLookupCandidate ? inferLookupFocus(rawTask) : ""
  );
  const localSurfaceLookupCandidate = Boolean(
    conversationKind === "local_surface_lookup"
    || (
      (signalLocalSurfaceLookup || runtimeVersionLookup)
      && !freshLiveLookupCandidate
      && !localProductHelpLookup
      && productHelpHits === 0
      && !workflowMetaCandidate
      && !sessionControlCandidate
    )
  );
  const resolvedLookupScope = conversationLookupScope
    || (freshLiveLookupCandidate ? "upstream_project" : (localSurfaceLookupCandidate ? "local_instance" : ""));

  let effectiveResearchHits = researchHits;
  let effectiveExternalLookupHits = externalLookupHits;
  let effectiveMutationHits = mutationHits;
  if (repoActivityLookup || boundedSoftwareUpdateLookup || freshLiveLookupCandidate) {
    effectiveResearchHits = Math.max(effectiveResearchHits, 1);
    effectiveExternalLookupHits = Math.max(effectiveExternalLookupHits, 1);
    effectiveMutationHits = 0;
  }

  let effectiveCodeHits = codeHits;
  let effectiveLocalStateHits = localStateHits;
  let effectiveRunnerNegativeHits = runnerNegativeHits;
  let effectiveRunnerReadOnlyIntentHits = runnerReadOnlyIntentHits;
  let effectiveRunnerTargetHits = runnerTargetHits;
  if (modelBenchmarkCandidate) {
    effectiveCodeHits = 0;
    effectiveResearchHits = 0;
    effectiveMutationHits = 0;
    effectiveLocalStateHits = Math.max(effectiveLocalStateHits, 1);
    effectiveRunnerNegativeHits = 0;
  }

  let effectiveWriteHits = writeHits;
  if (summaryOutputHits > 0 && effectiveCodeHits === 0 && effectiveResearchHits === 0 && effectiveMutationHits === 0) {
    effectiveWriteHits = 0;
  }
    if (
        explicitLocalProbe
        && effectiveRunnerReadOnlyIntentHits > 0
        && effectiveRunnerTargetHits > 0
        && effectiveCodeHits === 0
        && effectiveResearchHits === 0
        && effectiveMutationHits === 0
  ) {
    effectiveWriteHits = 0;
  }
  if (modelBenchmarkCandidate) {
    effectiveWriteHits = 0;
  }

  const shortAckCandidate = (
    ackFollowupHits > 0
    && rawTask.length <= 48
    && !normalizedCommand
    && runnerHits === 0
    && effectiveRunnerReadOnlyIntentHits === 0
    && effectiveRunnerTargetHits === 0
    && effectiveRunnerNegativeHits === 0
    && effectiveCodeHits === 0
    && effectiveResearchHits === 0
    && effectiveWriteHits === 0
    && summaryOutputHits === 0
    && multiStepHits === 0
    && parallelHits === 0
    && highRiskHits === 0
    && effectiveLocalStateHits === 0
    && remoteTargetHits === 0
    && verifyHits === 0
    && implementHits === 0
    && effectiveMutationHits === 0
  );
  const taskProgressCandidate = Boolean(
    taskProgressHits > 0
      && rawTask.length <= 80
      && !normalizedCommand
      && runnerHits === 0
      && codeHits === 0
      && effectiveResearchHits === 0
      && effectiveWriteHits === 0
      && summaryOutputHits === 0
      && multiStepHits === 0
      && parallelHits === 0
      && highRiskHits === 0
      && verifyHits === 0
      && implementHits === 0
      && effectiveMutationHits === 0,
  );

  let observerControlCandidate = Boolean(
    explicitObserverCommand || observerControlHits > 0 || workflowMetaCandidate || taskProgressCandidate
  );

  if (conversationKind === "execution_followup" || conversationKind === "task_followup") {
    workflowMetaCandidate = true;
    observerControlCandidate = true;
    effectiveResearchHits = 0;
    effectiveExternalLookupHits = 0;
    effectiveMutationHits = 0;
    effectiveCodeHits = 0;
    effectiveWriteHits = 0;
    effectiveRunnerNegativeHits = 0;
  } else if (conversationKind === "local_surface_lookup" || localSurfaceLookupCandidate) {
    explicitLocalProbe = true;
    effectiveLocalStateHits = Math.max(effectiveLocalStateHits, 1);
    effectiveRunnerReadOnlyIntentHits = Math.max(effectiveRunnerReadOnlyIntentHits, 1);
    effectiveRunnerTargetHits = Math.max(effectiveRunnerTargetHits, 1);
    effectiveResearchHits = 0;
    effectiveExternalLookupHits = 0;
    effectiveMutationHits = 0;
    effectiveCodeHits = 0;
    effectiveWriteHits = 0;
    effectiveRunnerNegativeHits = 0;
  } else if (conversationKind === "fresh_live_lookup") {
    observerControlCandidate = false;
    workflowMetaCandidate = false;
    sessionControlCandidate = false;
    effectiveResearchHits = 0;
    effectiveExternalLookupHits = Math.max(effectiveExternalLookupHits, 1);
    effectiveMutationHits = 0;
    effectiveCodeHits = 0;
    effectiveWriteHits = 0;
    effectiveRunnerNegativeHits = 0;
  }

  let estimatedSteps = 1;
  if (multiStepHits > 0) estimatedSteps += 1;
  if (effectiveResearchHits > 0) estimatedSteps += 1;
  if (effectiveCodeHits > 0) estimatedSteps += 1;
  if (effectiveWriteHits > 0) estimatedSteps += 1;
  if (parallelHits > 0) estimatedSteps += 1;
  if (verifyHits > 0) estimatedSteps += 1;
  if (effectiveMutationHits > 0) estimatedSteps += 1;
  if (rawTask.length > 140) estimatedSteps += 1;

  let taskShape = "single_step";
  if (estimatedSteps >= 4 || parallelHits > 0) taskShape = "staged";
  else if (estimatedSteps >= 2) taskShape = "multi_step";

  let contextGrowth = "low";
  if (effectiveCodeHits > 0 || effectiveLocalStateHits > 0 || verifyHits > 0 || effectiveMutationHits > 0) {
    contextGrowth = "medium";
  }
  if (estimatedSteps >= 4 || effectiveMutationHits > 0 || (effectiveResearchHits > 0 && (effectiveCodeHits > 0 || writeHits > 0))) {
    contextGrowth = "high";
  }

  let latencySensitivity = "normal";
  if (effectiveLocalStateHits > 0 || normalizedCommand || taskCommandReadOnly) latencySensitivity = "high";
  else if (effectiveExternalLookupHits > 0 && effectiveResearchHits === 0 && effectiveCodeHits === 0) latencySensitivity = "normal";

  const observationSignal = Boolean(
    observerControlCandidate
      || modelBenchmarkCandidate
      || normalizedCommand
      || taskCommandReadOnly
      || runnerHits > 0
      || effectiveLocalStateHits > 0
      || remoteTargetHits > 0
      || (effectiveRunnerReadOnlyIntentHits > 0 && effectiveRunnerTargetHits > 0),
  );

  const features = {
    task_length: rawTask.length,
    route_language_packs: [...enabledPacks],
    has_command: Boolean(normalizedCommand || taskCommandReadOnly),
    command_read_only: commandReadOnly,
    task_command_read_only: taskCommandReadOnly,
    runner_hits: runnerHits,
    runner_read_only_intent_hits: effectiveRunnerReadOnlyIntentHits,
    runner_target_hits: effectiveRunnerTargetHits,
    runner_negative_hits: effectiveRunnerNegativeHits,
    observer_control_hits: observerControlHits,
    task_progress_hits: taskProgressHits,
    observer_control_candidate: observerControlCandidate,
    task_progress_candidate: taskProgressCandidate,
    workflow_meta_hits: workflowMetaHits,
    workflow_meta_candidate: workflowMetaCandidate,
    session_control_hits: sessionControlHits,
    session_control_candidate: sessionControlCandidate,
    model_benchmark_hits: modelBenchmarkHits,
    model_reference_hits: modelReferenceHits,
    model_benchmark_candidate: modelBenchmarkCandidate,
    explicit_local_probe: explicitLocalProbe,
    code_hits: effectiveCodeHits,
    research_hits: effectiveResearchHits,
    external_lookup_hits: effectiveExternalLookupHits,
    write_hits: writeHits,
    summary_output_hits: summaryOutputHits,
    multi_step_hits: multiStepHits,
    parallel_hits: parallelHits,
    high_risk_hits: highRiskHits,
    simple_hits: simpleHits,
    product_help_hits: productHelpHits,
    local_product_help_lookup: localProductHelpLookup,
    local_state_hits: effectiveLocalStateHits,
    verify_hits: verifyHits,
    implement_hits: implementHits,
    mutation_hits: effectiveMutationHits,
    repo_activity_hits: repoActivityLookup ? 1 : 0,
    requires_external_lookup: effectiveExternalLookupHits > 0,
    bounded_software_update_lookup: boundedSoftwareUpdateLookup,
    bounded_repo_update_lookup: boundedRepoUpdateLookup,
    fresh_live_lookup: freshLiveLookupCandidate,
    cost_sensitive_hits: costSensitiveHits,
    semantic_ambiguity_hits: semanticAmbiguityHits,
    continuation_hits: continuationHits,
    ack_followup_hits: ackFollowupHits,
    remote_target_hits: remoteTargetHits,
    requires_tools: observationSignal,
    requires_code_work: effectiveCodeHits > 0,
    requires_research: effectiveResearchHits > 0,
    requires_mutation: effectiveMutationHits > 0 || (implementHits > 0 && (effectiveCodeHits > 0 || effectiveLocalStateHits > 0)),
    external_lookup_only: effectiveExternalLookupHits > 0 && effectiveResearchHits === 0 && effectiveCodeHits === 0 && writeHits === 0,
    bounded_external_inspect: (
      effectiveExternalLookupHits > 0
      && researchHits === 0
      && effectiveCodeHits === 0
      && effectiveWriteHits === 0
      && effectiveMutationHits === 0
      && summaryOutputHits === 0
    ),
    requires_writing: effectiveWriteHits > 0,
    estimated_steps: estimatedSteps,
    task_shape: taskShape,
    multi_step: estimatedSteps >= 2,
    parallelizable: (
      parallelHits > 0
      || (effectiveResearchHits > 0 && writeHits > 0 && multiStepHits > 0)
      || (verifyHits > 0 && (effectiveCodeHits > 0 || implementHits > 0))
    ),
    tool_observation_only: (
      observationSignal
      && effectiveMutationHits === 0
      && implementHits === 0
      && effectiveCodeHits === 0
      && effectiveResearchHits === 0
      && effectiveWriteHits === 0
      && !freshLiveLookupCandidate
    ),
    target_scope: remoteTargetHits > 0 ? "remote" : ((effectiveLocalStateHits > 0 || taskCommandReadOnly || explicitLocalProbe) ? "local" : "generic"),
    lookup_scope: resolvedLookupScope || ((explicitPortProbe && !freshLiveLookupCandidate) ? "local_instance" : "generic"),
    lookup_project: resolvedLookupProject,
    lookup_focus: resolvedLookupFocus,
    high_risk: highRiskHits > 0,
    ack_followup_candidate: shortAckCandidate,
    followup_candidate: continuationHits > 0 || shortAckCandidate,
    context_growth: contextGrowth,
    latency_sensitivity: latencySensitivity,
    simple_direct_candidate: simpleHits > 0 && runnerHits === 0 && effectiveCodeHits === 0 && effectiveResearchHits === 0 && effectiveLocalStateHits === 0,
  };

  features.hard_runner_candidate = Boolean(
    !features.fresh_live_lookup
    && !features.bounded_repo_update_lookup
    && !observerControlCandidate
    && effectiveRunnerNegativeHits === 0
    && !features.high_risk
    && !features.parallelizable
    && features.simple_hits === 0
    && features.summary_output_hits === 0
    && !features.requires_mutation
    && !features.requires_code_work
    && !features.requires_research
    && !features.requires_writing
    && features.estimated_steps <= 2
    && (
      modelBenchmarkCandidate
      || commandReadOnly
      || (
        effectiveRunnerReadOnlyIntentHits > 0
        && (effectiveRunnerTargetHits > 0 || runnerHits > 0 || effectiveLocalStateHits > 0 || remoteTargetHits > 0)
      )
      || (
        features.tool_observation_only
        && effectiveRunnerTargetHits > 0
        && (effectiveRunnerReadOnlyIntentHits > 0 || runnerHits > 0 || effectiveLocalStateHits > 0)
      )
    )
  );

  return features;
}

function directContractCandidate(features) {
  if (features.high_risk) return false;
  if (features.session_control_candidate) return true;
  if (features.observer_control_candidate) return true;
  if (features.fresh_live_lookup || features.bounded_repo_update_lookup) return true;
  if (features.requires_tools) return false;
  if (features.requires_mutation) return false;
  if (features.requires_code_work) return false;
  if (features.parallelizable) return false;
  if (Number(features.estimated_steps || 0) >= 3) return false;
  if (features.requires_research && !features.external_lookup_only) return false;
  if (features.requires_writing && !features.summary_output_hits) return false;
  if (["medium", "high"].includes(features.context_growth)) return false;
  return Boolean(
    features.simple_direct_candidate
      || features.external_lookup_only
      || (
        Number(features.task_length || 0) <= 120
        && Number(features.estimated_steps || 0) <= 2
        && !features.requires_research
        && !features.requires_writing
      )
  );
}

function inferParallelGainBand(features) {
  if (Number(features.parallel_hits || 0) > 0) return "high";
  if (features.parallelizable && (
    Number(features.estimated_steps || 0) >= 5
    || (features.requires_code_work && Number(features.verify_hits || 0) > 0)
  )) return "high";
  if (features.parallelizable || Number(features.estimated_steps || 0) >= 4) return "medium";
  return "low";
}

function coordinatedWorkCandidate(features) {
  if (!features.parallelizable) return false;
  if (Number(features.parallel_hits || 0) > 0) return true;
  if (Number(features.estimated_steps || 0) >= 5) return true;
  if (features.requires_code_work && Number(features.verify_hits || 0) > 0 && Number(features.estimated_steps || 0) >= 4) return true;
  if (features.high_risk && Number(features.estimated_steps || 0) >= 4) return true;
  return false;
}

function inferWorkContractHint(features, route = "") {
  if (route === "runner" || features.hard_runner_candidate) return "inspect_report";
  if (features.model_benchmark_candidate) return "inspect_report";
  if (features.session_control_candidate) return "answer_now";
  if (features.observer_control_candidate) return "answer_now";
  if (features.fresh_live_lookup) return "inspect_report";
  if (features.bounded_external_inspect) return "inspect_report";
  if (directContractCandidate(features)) return "answer_now";
  if (coordinatedWorkCandidate(features)) return "coordinated_work";
  if (features.tool_observation_only) return "inspect_report";
  return "deliverable_work";
}

function inferContractKind(features, workContractHint = "") {
  if (features.session_control_candidate) return "session_control";
  if (features.observer_control_candidate) return "answer_now";
  if (features.model_benchmark_candidate) return "probe_measurement";
  if (workContractHint === "inspect_report") return "inspect_report";
  if (Number(features.verify_hits || 0) > 0 && !features.requires_mutation) return "review";
  if (features.requires_mutation || features.requires_code_work) return "implement";
  if (workContractHint === "answer_now") return "answer_now";
  if (workContractHint === "coordinated_work") return "coordinated_work";
  return "deliverable_work";
}

function inferScopeHint(features, contractKind = "", workContractHint = "") {
  if (contractKind === "session_control") return "current-session-only";
  if (features.observer_control_candidate) return "runtime-read-model";
  if (
    contractKind === "probe_measurement"
    || workContractHint === "inspect_report"
    || features.tool_observation_only
    || features.bounded_external_inspect
    || features.target_scope !== "generic"
  ) {
    return "workflow-local";
  }
  if (features.requires_mutation || features.requires_code_work || features.requires_research || features.requires_writing) {
    return "delegated-worker-doable";
  }
  return "main-session";
}

function inferCapabilityRequirements(features, contractKind = "", scopeHint = "") {
  const requirements = [];
  switch (contractKind) {
    case "session_control":
      requirements.push("current_session_mutation");
      break;
    case "probe_measurement":
      requirements.push("structured_report", "measurement_probe");
      break;
    case "inspect_report":
      requirements.push("structured_report", "read_only_inspection");
      break;
    case "review":
      requirements.push("structured_report", "evidence_review");
      break;
    case "implement":
      requirements.push("artifact_output", "mutation_or_code_execution");
      break;
    case "answer_now":
      requirements.push("text_answer");
      break;
    default:
      requirements.push("artifact_output");
      break;
  }
  if (scopeHint === "runtime-read-model") requirements.push("runtime_read_model");
  if (scopeHint === "current-session-only") requirements.push("current_session_scope");
  if (features.target_scope === "local") requirements.push("local_read_probe");
  if (features.target_scope === "remote") requirements.push("remote_read_probe");
  if (features.bounded_external_inspect) requirements.push("external_read_query");
  if (features.fresh_live_lookup) requirements.push("fresh_live_lookup");
  return [...new Set(requirements)];
}

function buildRunnerPlaybookHints(features = {}) {
  return {
    lookup_scope: String(features.lookup_scope || "").trim(),
    lookup_project: String(features.lookup_project || "").trim(),
    lookup_focus: String(features.lookup_focus || "").trim(),
    target_scope: String(features.target_scope || "").trim(),
  };
}

function explicitRunnerCommandPlan(command = "") {
  const normalized = String(command || "").trim();
  if (!normalized) return null;
  return {
    kind: "explicit_command",
    summary: "执行显式只读 runner 命令",
    command: normalized,
    probe_spec: {
      kind: "explicit_command",
    },
    reason_codes: ["runner_explicit_command"],
    confidence: 1,
  };
}

function resolveRunnerMaterialization(task, command = "", features = {}) {
  if (String(command || "").trim() && (features.command_read_only || features.task_command_read_only)) {
    return explicitRunnerCommandPlan(command);
  }
  return inferRunnerPlaybook(task, buildRunnerPlaybookHints(features));
}

function boundedDirectRunnerFallback(features = {}) {
  return Boolean(
    features.tool_observation_only
      && !features.high_risk
      && !features.requires_mutation
      && !features.requires_code_work
      && !features.requires_research
      && !features.requires_external_lookup
      && !features.requires_writing
      && !features.parallelizable
      && Number(features.estimated_steps || 0) <= 1
      && Number(features.task_length || 0) <= 120
  );
}

function safeLocalSurfaceDirectInspect(features = {}) {
  return Boolean(
    features.explicit_local_probe
      && features.target_scope === "local"
      && features.lookup_scope === "local_instance"
      && !features.high_risk
      && !features.requires_mutation
      && !features.requires_code_work
      && !features.requires_research
      && !features.requires_external_lookup
      && !features.parallelizable
      && Number(features.estimated_steps || 0) <= 2
  );
}

function buildLaneFeasibility(features, contractKind = "", scopeHint = "", workContractHint = "", runnerMaterialization = null) {
  const baseline = {
    direct: { feasible: false, reasons: [] },
    runner: { feasible: false, reasons: [] },
    spawn_single: { feasible: false, reasons: [] },
    spawn_multi: { feasible: false, reasons: [] },
    session_control: { feasible: false, reasons: [] },
  };

  if (scopeHint === "current-session-only") {
    baseline.direct = { feasible: true, reasons: ["scope:current-session-only"] };
    baseline.session_control = {
      feasible: contractKind === "session_control",
      reasons: [contractKind === "session_control" ? "contract:session_control" : "contract_mismatch"],
    };
    baseline.runner.reasons.push("scope_current_session_only");
    baseline.spawn_single.reasons.push("scope_current_session_only");
    baseline.spawn_multi.reasons.push("scope_current_session_only");
    return baseline;
  }

  if (scopeHint === "runtime-read-model") {
    baseline.direct = { feasible: true, reasons: ["scope:runtime-read-model"] };
    baseline.runner.reasons.push("scope_runtime_read_model");
    baseline.spawn_single.reasons.push("scope_runtime_read_model");
    baseline.spawn_multi.reasons.push("scope_runtime_read_model");
    baseline.session_control.reasons.push("scope_runtime_read_model");
    return baseline;
  }

  if (contractKind === "probe_measurement") {
    const runnerFeasible = Boolean(runnerMaterialization);
    baseline.runner = {
      feasible: runnerFeasible,
      reasons: runnerFeasible
        ? ["contract:probe_measurement", "capability:runner_probe_or_snapshot"]
        : ["runner_materialization_missing", "probe_measurement_requires_registered_runner_workflow"],
    };
    baseline.direct.reasons.push("runner_workflow_required");
    baseline.spawn_single = {
      feasible: !runnerFeasible,
      reasons: [runnerFeasible ? "no_probe_measurement_capability" : "runner_materialization_missing_spawn_fallback"],
    };
    baseline.spawn_multi.reasons.push("no_probe_measurement_capability");
    baseline.session_control.reasons.push("contract_mismatch");
    return baseline;
  }

  if (contractKind === "inspect_report") {
    const runnerFeasible = Boolean(runnerMaterialization);
    baseline.runner = {
      feasible: runnerFeasible,
      reasons: runnerFeasible
        ? ["contract:inspect_report", "capability:runner_inspect"]
        : ["runner_materialization_missing", "inspect_report_runner_requires_registered_workflow"],
    };
    const localSurfaceDirectInspect = safeLocalSurfaceDirectInspect(features);
    const freshLiveDegradedDirect = !runnerFeasible && features.fresh_live_lookup && !features.high_risk && !features.requires_mutation && !features.requires_code_work;
    const directEligible = localSurfaceDirectInspect
      || freshLiveDegradedDirect
      || (!runnerFeasible && boundedDirectRunnerFallback(features))
      || (!features.requires_tools
      && !features.requires_external_lookup
      && !features.requires_research
      && !features.requires_code_work
      && !features.requires_writing
      && !features.fresh_live_lookup
      && Number(features.estimated_steps || 0) <= 1
      && Number(features.task_length || 0) <= 80);
    baseline.direct = {
      feasible: directEligible,
      reasons: [directEligible
        ? (
          freshLiveDegradedDirect
            ? "degraded_direct_lookup_runner_unavailable"
            : (localSurfaceDirectInspect
              ? "local_surface_direct_inspect"
              : (!runnerFeasible && boundedDirectRunnerFallback(features)
                ? "runner_materialization_missing_direct_fallback"
                : "bounded_direct_inspect"))
        )
        : "inspect_prefers_workflow"],
    };
    const deepInspect = !features.bounded_external_inspect
      && !features.model_benchmark_candidate
      && (
        !features.tool_observation_only
        || (!features.explicit_local_probe && (Number(features.summary_output_hits || 0) > 0 || Number(features.write_hits || 0) > 0))
      )
      && (
        features.requires_research
        || features.requires_code_work
        || Number(features.summary_output_hits || 0) > 0
        || Number(features.write_hits || 0) > 0
        || Number(features.verify_hits || 0) > 0
        || Number(features.task_length || 0) > 120
        || Number(features.estimated_steps || 0) > 2
      );
    baseline.spawn_single = {
      feasible: deepInspect || (!runnerFeasible && !directEligible),
      reasons: [
        deepInspect
          ? "deep_inspect_handoff"
          : (!runnerFeasible && !directEligible ? "runner_materialization_missing_spawn_fallback" : "runner_playbook_preferred"),
      ],
    };
    baseline.spawn_multi.reasons.push("inspect_report_not_parallel_default");
    baseline.session_control.reasons.push("contract_mismatch");
    return baseline;
  }

  if (contractKind === "review") {
    baseline.spawn_single = { feasible: true, reasons: ["contract:review"] };
    baseline.spawn_multi = {
      feasible: coordinatedWorkCandidate(features),
      reasons: [coordinatedWorkCandidate(features) ? "parallel_review_possible" : "single_review_default"],
    };
    baseline.direct.reasons.push("review_requires_handoff");
    baseline.runner.reasons.push("review_not_runner_default");
    baseline.session_control.reasons.push("contract_mismatch");
    return baseline;
  }

  if (contractKind === "implement") {
    baseline.spawn_single = { feasible: true, reasons: ["contract:implement"] };
    baseline.spawn_multi = {
      feasible: coordinatedWorkCandidate(features),
      reasons: [coordinatedWorkCandidate(features) ? "parallel_implement_possible" : "single_worker_default"],
    };
    baseline.direct.reasons.push("implement_requires_worker");
    baseline.runner.reasons.push("implement_not_runner_capability");
    baseline.session_control.reasons.push("contract_mismatch");
    return baseline;
  }

  if (contractKind === "answer_now") {
    baseline.direct = { feasible: true, reasons: ["contract:answer_now"] };
    baseline.runner.reasons.push("answer_now_prefers_direct");
    baseline.spawn_single.reasons.push("answer_now_prefers_direct");
    baseline.spawn_multi.reasons.push("answer_now_prefers_direct");
    baseline.session_control.reasons.push("contract_mismatch");
    return baseline;
  }

  baseline.spawn_single = { feasible: true, reasons: [`contract:${workContractHint || contractKind || "deliverable_work"}`] };
  baseline.spawn_multi = {
    feasible: workContractHint === "coordinated_work" || coordinatedWorkCandidate(features),
    reasons: [workContractHint === "coordinated_work" || coordinatedWorkCandidate(features) ? "parallel_deliverable_possible" : "single_worker_default"],
  };
  baseline.direct.reasons.push("deliverable_requires_handoff");
  baseline.runner.reasons.push("deliverable_not_runner_default");
  baseline.session_control.reasons.push("contract_mismatch");
  return baseline;
}

function feasibleLanesFromBaseline(laneFeasibility = {}) {
  return Object.entries(laneFeasibility)
    .filter(([, value]) => value && typeof value === "object" && value.feasible)
    .map(([lane]) => lane);
}

function chooseFeasibleRoute(preferredRoute, scores = {}, laneFeasibility = {}) {
  const preferred = String(preferredRoute || "").trim();
  const preferredState = laneFeasibility[preferred];
  if (!preferred || !preferredState || preferredState.feasible) {
    return { route: preferredRoute, reasonCodes: [] };
  }

  const candidates = ["direct", "runner", "spawn_single", "spawn_multi"]
    .filter((lane) => laneFeasibility[lane]?.feasible)
    .sort((left, right) => Number(scores[right] || 0) - Number(scores[left] || 0));
  const fallback = candidates[0] || preferredRoute || "direct";
  return {
    route: fallback,
    reasonCodes: fallback === preferred
      ? []
      : [`feasibility_filter:${preferred}_to_${fallback}`],
  };
}

function contractDrivenRouteBias(features, workContractHint) {
  const scores = {
    direct: 0.0,
    runner: 0.0,
    spawn_single: 0.0,
    spawn_multi: 0.0,
  };
  const reasonCodes = [`work_contract:${workContractHint}`];

  if (workContractHint === "answer_now") {
    scores.direct = 0.82;
    scores.spawn_single = 0.36;
    if (features.session_control_candidate) {
      scores.direct = 0.97;
      scores.spawn_single = 0.04;
      reasonCodes.push("session_control_direct_contract");
    } else if (features.observer_control_candidate) {
      scores.direct = 0.96;
      scores.spawn_single = 0.08;
      reasonCodes.push(features.workflow_meta_candidate ? "workflow_meta_control_contract" : "observer_control_contract");
    } else {
      reasonCodes.push((features.external_lookup_only || features.fresh_live_lookup) ? "direct_lookup_contract" : "direct_answer_contract");
    }
  } else if (workContractHint === "inspect_report") {
    scores.spawn_single = 0.72;
    scores.runner = 0.44;
    reasonCodes.push("inspect_report_contract");
    if (features.requires_tools) reasonCodes.push("tool_observation_contract");
    if (features.tool_observation_only) {
      scores.runner = 0.82;
      scores.spawn_single = 0.54;
      reasonCodes.push("tool_observation_only");
    }
  } else if (workContractHint === "coordinated_work") {
    scores.spawn_multi = 0.78;
    scores.spawn_single = 0.67;
    reasonCodes.push("coordinated_work_contract");
    reasonCodes.push(`parallel_gain:${inferParallelGainBand(features)}`);
  } else {
    scores.spawn_single = 0.82;
    scores.direct = 0.08;
    reasonCodes.push("deliverable_work_contract");
  }

  if (features.high_risk) {
    scores.direct = Math.max(0.0, scores.direct - 0.4);
    scores.spawn_single += 0.08;
    scores.spawn_multi += 0.08;
    reasonCodes.push("high_risk");
  }
  if (features.requires_mutation) {
    scores.direct = 0.0;
    scores.runner = Math.max(0.0, scores.runner - 0.35);
    scores.spawn_single += 0.18;
    reasonCodes.push("mutation_work");
  }
  if (features.requires_code_work) {
    scores.direct = 0.0;
    scores.spawn_single += 0.14;
    reasonCodes.push("code_work");
  }
  if (features.requires_research) {
    scores.direct = Math.max(0.0, scores.direct - 0.18);
    scores.spawn_single += 0.08;
    reasonCodes.push("research_work");
  }
  if (features.requires_writing) {
    scores.runner = Math.max(0.0, scores.runner - 0.18);
    scores.spawn_single += 0.08;
    reasonCodes.push("writing_work");
  }
  if (features.multi_step) {
    scores.spawn_single += 0.06;
    reasonCodes.push("multi_step");
  }
  if (features.parallelizable) {
    scores.spawn_multi += 0.06;
    reasonCodes.push("parallelizable");
  }

  let route = Object.entries(scores).sort((left, right) => right[1] - left[1])[0][0];
  if (workContractHint === "inspect_report") {
    if (features.model_benchmark_candidate) {
      route = "runner";
      reasonCodes.push("prefer_runner_for_model_benchmark");
    } else if (features.fresh_live_lookup) {
      route = "runner";
      reasonCodes.push("prefer_runner_for_fresh_live_lookup");
    } else if (features.bounded_external_inspect) {
      route = "runner";
      reasonCodes.push("prefer_runner_for_external_lookup_inspect");
    } else if (
      safeLocalSurfaceDirectInspect(features)
    ) {
      route = "direct";
      reasonCodes.push("prefer_direct_for_local_surface_probe");
    } else if (features.explicit_local_probe || features.hard_runner_candidate) {
      route = "runner";
      reasonCodes.push("prefer_runner_for_explicit_probe");
    } else {
      route = "spawn_single";
      reasonCodes.push("prefer_spawn_single_over_soft_runner_bias");
    }
  }
  if (workContractHint === "coordinated_work" && inferParallelGainBand(features) === "medium") {
    route = "spawn_single";
    reasonCodes.push("prefer_spawn_single_over_weak_multi_bias");
  }
  if (workContractHint === "answer_now" && !directContractCandidate(features)) {
    route = "spawn_single";
    reasonCodes.push("direct_contract_veto_to_spawn_single");
  }
  if (features.session_control_candidate) {
    route = "direct";
    reasonCodes.push("prefer_direct_session_control_lane");
  } else if (features.observer_control_candidate) {
    route = "direct";
    reasonCodes.push("prefer_direct_control_lane");
  }

  const orderedScores = Object.values(scores).sort((a, b) => b - a);
  const topScore = orderedScores[0] || 0.0;
  const secondScore = orderedScores[1] || 0.0;
  const confidence = roundTo(Math.min(1.0, topScore));
  const scoreMargin = roundTo(topScore - secondScore);
  return {
    route,
    scores: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, roundTo(value)])),
    reasonCodes,
    scoreMargin: Math.max(scoreMargin, 0.0),
    confidence,
  };
}

function inferWorkTypeHint(features, route, workContractHint = "") {
  if (route === "runner") return "ops";
  if (workContractHint === "inspect_report") return Number(features.verify_hits || 0) > 0 ? "review" : "research";
  if (Number(features.verify_hits || 0) > 0 && !features.requires_mutation) return "review";
  if (features.requires_mutation || features.requires_code_work) return "code";
  return "research";
}

function inferPhaseHint(features, route, workType, workContractHint = "") {
  if (route === "runner") return "inspect";
  if (workContractHint === "inspect_report" && workType === "research") return "inspect";
  if (workType === "review") return "verify";
  if (workType === "code") return "implement";
  if (features.requires_writing || Number(features.summary_output_hits || 0) > 0) return "report";
  if (features.high_risk) return "inspect";
  return "collect";
}

function inferModelBandHint(features, route, workType) {
  if (route === "runner") return "fast";
  if (route === "spawn_multi") return "strong";
  if (features.high_risk) return "strong";
  if (Number(features.estimated_steps || 0) >= 5 || (features.parallelizable && Number(features.estimated_steps || 0) >= 3)) {
    return "heavy";
  }
  if (workType === "review") return "strong";
  if (workType === "code" && (features.requires_mutation || Number(features.verify_hits || 0) > 0)) return "strong";
  if (features.requires_code_work || features.requires_research || features.requires_writing || Number(features.summary_output_hits || 0) > 0) {
    return "normal";
  }
  return route === "direct" ? "fast" : "normal";
}

function expectedLatencyMs(route, features) {
  if (route === "runner") return Number(features.estimated_steps || 0) <= 2 ? 1500 : 3500;
  if (route === "direct") return Number(features.task_length || 0) <= 80 ? 1200 : 3500;
  if (route === "spawn_single") return features.requires_code_work ? 12000 : 9000;
  return 18000;
}

function expectedCostBand(route, features) {
  if (route === "runner") return "low";
  if (route === "direct") return features.requires_research ? "medium" : "low";
  if (route === "spawn_single") return "medium";
  return "high";
}

function inferTaskClass(features, route) {
  if (route === "direct" && features.session_control_candidate) return "session_control";
  if (route === "direct" && features.observer_control_candidate) return "control_observer";
  if (route === "direct" && features.tool_observation_only && features.target_scope === "local") return "fast_local_check";
  if (route === "direct" && features.tool_observation_only) return "fast_tool_check";
  if (route === "direct" && features.fresh_live_lookup) return "simple_lookup";
  if (route === "direct" && features.bounded_repo_update_lookup) return "simple_lookup";
  if (route === "runner") {
    if (features.target_scope === "remote") return "fast_remote_check";
    if (features.target_scope === "local") return "fast_local_check";
    return "fast_tool_check";
  }
  if (features.requires_mutation && route.startsWith("spawn")) return "focused_local_change";
  if (route === "direct" && features.external_lookup_only) return "simple_lookup";
  if (route === "direct") return "direct_answer";
  if (route === "spawn_multi") return "staged_workflow";
  if (features.requires_code_work) return "focused_code_work";
  if (features.requires_research) return "focused_research";
  return "focused_subtask";
}

function inferExecutionOwner(route) {
  if (route === "direct") return "main_agent";
  if (route === "runner") return "persistent_runner";
  return "subagent";
}

function inferProtectedLane(features, route, taskClass) {
  if (route === "direct" && taskClass === "session_control") return "session_control";
  if (route === "direct" && taskClass === "control_observer") return "control_observer";
  if (route === "direct" && features.workflow_meta_candidate) return "workflow_meta";
  return "";
}

function chooseSemanticModelHint() {
  const policy = loadJson(MODEL_POLICY_FILE);
  if (policy && typeof policy === "object" && !Array.isArray(policy)) {
    const workerPools = policy.worker_pools;
    if (workerPools && typeof workerPools === "object" && !Array.isArray(workerPools)) {
      const modelId = String(workerPools["octoclaw-runner"] || "").trim();
      if (modelId) return modelId;
    }
    const mainModel = String(policy.main_model || "").trim();
    if (mainModel) return mainModel;
  }
  return "minimax-portal/MiniMax-M2.7-highspeed";
}

function shouldRequestSemanticReview(features, scores, route, workContractHint) {
  const ordered = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  if (ordered.length < 2) return { needsSemanticReview: false, scoreMargin: 1.0, semanticReason: "" };
  const [topRoute, topScore] = ordered[0];
  const [secondRoute, secondScore] = ordered[1];
  const margin = roundTo(Number(topScore) - Number(secondScore));

  if (route === "direct") return { needsSemanticReview: false, scoreMargin: margin, semanticReason: "" };
  if (features.requires_mutation && route === "runner") {
    return { needsSemanticReview: true, scoreMargin: margin, semanticReason: "mutation_vs_runner" };
  }
  if (workContractHint === "inspect_report" && !features.hard_runner_candidate) {
    if (features.requires_research || features.requires_writing || Number(features.semantic_ambiguity_hits || 0) > 0) {
      return { needsSemanticReview: true, scoreMargin: margin, semanticReason: "inspect_report_boundary" };
    }
  }
  if (workContractHint === "coordinated_work" && inferParallelGainBand(features) === "medium") {
    return { needsSemanticReview: true, scoreMargin: margin, semanticReason: "single_vs_multi_boundary" };
  }
  if (Number(features.semantic_ambiguity_hits || 0) > 0 && margin < 0.55) {
    return { needsSemanticReview: true, scoreMargin: margin, semanticReason: "ambiguous_task_shape" };
  }
  if (features.requires_research && features.requires_tools && margin < 0.6) {
    return { needsSemanticReview: true, scoreMargin: margin, semanticReason: "research_with_tools" };
  }
  if (Number(features.estimated_steps || 0) >= 3 && topRoute !== secondRoute && margin < 0.45) {
    return { needsSemanticReview: true, scoreMargin: margin, semanticReason: "close_score_multi_step" };
  }
  return { needsSemanticReview: false, scoreMargin: margin, semanticReason: "" };
}

function hardGateRoute(features, runtimeCfg = null, runnerMaterialization = null) {
  const switches = runtimeCfg?.switches && typeof runtimeCfg.switches === "object" ? runtimeCfg.switches : {};
  if (!Boolean("hard_runner_only" in switches ? switches.hard_runner_only : true)) {
    return { route: null, reasons: [] };
  }
  if (safeLocalSurfaceDirectInspect(features)) {
    return { route: null, reasons: [] };
  }
  if (features.hard_runner_candidate && runnerMaterialization) {
    const reasons = ["hard_runner_only"];
    if (runnerMaterialization.kind === "explicit_command") reasons.push("explicit_read_only_command");
    else reasons.push("precomputed_runner_materialization");
    if (features.target_scope === "remote") reasons.push("remote_read_only_probe");
    else if (features.target_scope === "local") reasons.push("local_read_only_probe");
    return { route: "runner", reasons };
  }
  return { route: null, reasons: [] };
}

export function inferRoute(task, command = "", metadata = {}) {
  const runtimeCfg = loadOctoClawConfig().runtime_policy || {};
  const enabledPacks = normalizeEnabledLanguagePacks(runtimeCfg);
  const features = extractFeatures(task, command, runtimeCfg, metadata);
  const runnerMaterialization = resolveRunnerMaterialization(task, command, features);
  const { route: hardRoute, reasons: hardReasons } = hardGateRoute(features, runtimeCfg, runnerMaterialization);

  let route = hardRoute;
  let workContractHint = "";
  let scores = { direct: 0.0, runner: 0.0, spawn_single: 0.0, spawn_multi: 0.0 };
  let reasonCodes = [];
  let scoreMargin = 1.0;
  let confidence = 0.0;

  if (hardRoute) {
    workContractHint = inferWorkContractHint(features, hardRoute);
    scores[route] = 1.0;
    reasonCodes = [...hardReasons, `work_contract:${workContractHint}`];
    confidence = route === "runner" || route === "direct" ? 0.92 : 0.88;
  } else {
    workContractHint = inferWorkContractHint(features);
    const inferred = contractDrivenRouteBias(features, workContractHint);
    route = inferred.route;
    scores = inferred.scores;
    reasonCodes = inferred.reasonCodes;
    scoreMargin = inferred.scoreMargin;
    confidence = inferred.confidence;
  }

  const contractKind = inferContractKind(features, workContractHint);
  const scopeHint = inferScopeHint(features, contractKind, workContractHint);
  const capabilityRequirements = inferCapabilityRequirements(features, contractKind, scopeHint);
  const laneFeasibility = buildLaneFeasibility(features, contractKind, scopeHint, workContractHint, runnerMaterialization);
  const feasibleRoute = chooseFeasibleRoute(route, scores, laneFeasibility);
  if (feasibleRoute.route !== route) {
    route = feasibleRoute.route;
    reasonCodes.push(...feasibleRoute.reasonCodes);
    if (features.fresh_live_lookup && route === "direct") {
      reasonCodes.push("degraded_direct_lookup");
    }
  }
  const feasibleLanes = feasibleLanesFromBaseline(laneFeasibility);

  const semantic = shouldRequestSemanticReview(features, scores, route, workContractHint);
  const workTypeHint = inferWorkTypeHint(features, route, workContractHint);
  const phaseHint = inferPhaseHint(features, route, workTypeHint, workContractHint);
  const workerPoolHint = taxonomyInferWorkerPool(route, workTypeHint);
  const modelBandHint = inferModelBandHint(features, route, workTypeHint);
  const taskClass = inferTaskClass(features, route);
  const protectedLane = inferProtectedLane(features, route, taskClass);
  const parallelGainBand = inferParallelGainBand(features);
  const needsDurableRuntime = route !== "direct" || ["deliverable_work", "coordinated_work"].includes(workContractHint);
  const needsArtifact = ["inspect_report", "deliverable_work", "coordinated_work"].includes(workContractHint);
  const shouldWait = route === "runner";
  const waitTimeoutSeconds = route === "runner" ? (Number(features.estimated_steps || 0) <= 2 ? 8 : 12) : 0;

  return {
    system_preferred_route: route,
    route,
    route_language_packs: [...enabledPacks],
    confidence: roundTo(confidence),
    reason: reasonCodes[0] || "default_route",
    reasons: [...reasonCodes],
    reason_codes: [...reasonCodes],
    scores,
    features,
    task_class: taskClass,
    protected_lane: protectedLane,
    work_contract_hint: workContractHint,
    contract_kind: contractKind,
    scope_hint: scopeHint,
    capability_requirements: capabilityRequirements,
    lane_feasibility: laneFeasibility,
    feasible_lanes: feasibleLanes,
    worker_pool_hint: workerPoolHint,
    work_type_hint: workTypeHint,
    phase_hint: phaseHint,
    model_band_hint: modelBandHint,
    parallel_gain_band: parallelGainBand,
    needs_durable_runtime: needsDurableRuntime,
    needs_artifact: needsArtifact,
    expected_latency_ms: expectedLatencyMs(route, features),
    expected_cost_band: expectedCostBand(route, features),
    context_growth_band: features.context_growth,
    execution_owner: inferExecutionOwner(route),
    dispatch_required: route !== "direct",
    main_agent_can_execute_directly: route === "direct",
    should_wait: shouldWait,
    wait_timeout_seconds: waitTimeoutSeconds,
    needs_semantic_review: semantic.needsSemanticReview,
    semantic_review_reason: semantic.semanticReason,
    score_margin: semantic.scoreMargin,
    semantic_model_hint: semantic.needsSemanticReview ? chooseSemanticModelHint() : "",
    runner_materialization_available: Boolean(runnerMaterialization),
    runner_materialization_kind: String(runnerMaterialization?.kind || ""),
    runner_playbook: runnerMaterialization ? { ...runnerMaterialization } : {},
    source: String(task || "").trim(),
  };
}
