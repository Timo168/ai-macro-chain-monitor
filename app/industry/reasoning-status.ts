import type {IndustryResearch} from '../../lib/industry/types';

const diagnosticText:Record<string,{reason:string;action:string}>={
 key_not_configured:{reason:'外部推理 API 尚未配置。',action:'当前继续使用规则引擎；本地推理可在运行环境准备完成后单独验收，无需外部 API 密钥。'},
 local_not_configured:{reason:'本地推理运行环境尚未配置完成。',action:'先准备本机模型服务，再使用实际研究数据完成一次推理与证据校验。'},
 local_model_missing:{reason:'本机尚未安装所配置的模型。',action:'管理员需在本机安装所选模型，再运行推理验收。'},
 local_service_unavailable:{reason:'本机模型服务暂时无法连接。',action:'管理员需检查本机推理服务；现有规则结论继续保留。'},
 local_unavailable:{reason:'本机模型服务暂时无法连接。',action:'管理员需检查本机推理服务；现有规则结论继续保留。'},
 local_timeout:{reason:'本机推理超过等待时间。',action:'现有结果继续保留；管理员需检查本机资源，必要时缩减输入或调整等待时间后重试。'},
 local_thinking_unsupported:{reason:'当前本机模型尚未确认支持思考模式。',action:'管理员需核对模型及 Ollama 版本，选择支持 thinking 的本地模型后重新验收。'},
 local_request_failed:{reason:'本机推理请求未完成。',action:'管理员需检查本机 Ollama 服务与模型状态，修复后重新验收。'},
 local_remote_model_not_allowed:{reason:'所选模型不是允许使用的本地模型。',action:'请使用已下载到本机的模型；当前未调用外部推理服务。'},
 context_limit:{reason:'研究数据超过本机模型可接受的上下文长度。',action:'管理员需调整研究输入或本地模型配置，再运行验收。'},
 auth_failed:{reason:'API 身份校验未通过。',action:'管理员需检查后台密钥是否有效，并重新运行启用验收。'},
 access_denied:{reason:'当前 API 项目没有所需权限。',action:'管理员需检查项目权限与所选模型的访问权限。'},
 quota_exceeded:{reason:'API 可用额度不足。',action:'管理员需检查 API 账户额度及项目预算，恢复后重新验收。'},
 rate_limited:{reason:'API 请求暂时受到频率限制。',action:'后台将在允许重试后再次尝试。'},
 model_unavailable:{reason:'配置的模型不可用。',action:'管理员需核对模型名称及账户访问权限。'},
 timeout:{reason:'本次推理超过等待时间。',action:'后台保留现有结论，并按重试计划再次尝试。'},
 network_error:{reason:'后台暂时无法连接推理服务。',action:'管理员需检查服务连通性；后台保留现有结论。'},
 provider_unavailable:{reason:'推理服务暂时不可用。',action:'后台将在允许重试后再次尝试。'},
 invalid_response:{reason:'模型未返回可用的结构化结果。',action:'管理员需检查后台验收记录，再运行启用验收。'},
 output_rejected:{reason:'模型结果未通过证据校验。',action:'当前继续展示规则结论；管理员需检查引用、情景和判断边界。'},
 incomplete_output:{reason:'模型本次输出未完成。',action:'管理员需检查输出预算和后台诊断，再运行启用验收。'},
 refused:{reason:'模型本次没有返回研究结论。',action:'管理员需检查研究输入与后台诊断，再运行启用验收。'},
 automation_disabled:{reason:'自动推理尚未开启。',action:'先运行一次后台启用验收，检查输出质量与实际用量，再决定是否开启自动调用。'},
 request_invalid:{reason:'本次推理请求配置未被接受。',action:'管理员需核对模型参数与后台诊断。'},
 request_failed:{reason:'本次推理请求未成功。',action:'管理员需检查后台诊断，处理后重新运行启用验收。'},
 output_limit:{reason:'本次推理达到输出上限，结果尚未完成。',action:'管理员需检查输出预算及实际用量，再运行验收。'},
 content_filtered:{reason:'本次推理未返回可验收的研究结果。',action:'管理员需检查研究输入与后台诊断。'},
 empty_output:{reason:'本次推理返回内容为空。',action:'管理员需检查后台诊断，再运行启用验收。'},
 invalid_json:{reason:'模型未返回有效的结构化结果。',action:'管理员需检查后台验收记录，再运行启用验收。'},
};

export function reasoningStatus(research:Pick<IndustryResearch,'model'|'analysis'|'modelAudit'>){
 const {model,analysis,modelAudit}=research;
 const local=model.providerId==='ollama'||/ollama/i.test(model.provider);
 const active=['ready','cached'].includes(model.status)&&analysis.origin==='model';
 const sameInput=active&&model.status==='cached'&&model.cacheReason==='unchanged_input';
 const title=active?(model.status==='ready'?'真实推理已生成':sameInput?'复用已验证推理':'展示上次成功推理'):
  model.status==='not_configured'?(local?'等待配置本地推理':'等待配置推理服务'):model.errorCode==='automation_disabled'?'自动推理未开启':model.status==='deferred'?'等待后台调用':
  model.status==='rejected'?'推理结果未通过校验':model.status==='fetch_failed'?'推理调用未成功':'真实推理尚未通过验收';
 const explanation=active?(sameInput?'输入数据未变，复用同一版本的模型解释。':model.status==='cached'?'当前使用上次成功且与输入匹配的模型解释。':local?'当前解释来自本机模型的真实响应，并已通过程序证据校验。':'当前解释来自真实 API 响应，并已通过程序证据校验。'):
  '当前分数与研究倾向由规则引擎生成，尚未使用本次真实模型推理。';
 const diagnostic=model.status==='not_configured'?(local?diagnosticText.local_not_configured:diagnosticText.key_not_configured):
  model.errorCode?diagnosticText[model.errorCode]??{reason:'推理调用未成功。',action:'管理员请查看后台诊断，处理后重新运行启用验收。'}:
  model.status==='rejected'?diagnosticText.output_rejected:
  model.error?{reason:'最近一次模型调用未成功。',action:'管理员请查看后台诊断；公开页面不展示原始错误内容。'}:null;
 const successfulCalls=typeof modelAudit?.successfulCalls==='number'&&Number.isInteger(modelAudit.successfulCalls)&&modelAudit.successfulCalls>=0?modelAudit.successfulCalls:0;
 return {active,local,title,explanation,diagnostic,successfulCalls,actualModel:active?(model.resolvedModel??model.model):null};
}
