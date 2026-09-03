// Bootstrap de Domínios — ponto único de registro.
// Para adicionar um novo domínio (Administração, Medicina, Direito...) basta registrar um
// novo módulo aqui (import side-effect) — NENHUMA alteração no Core é necessária.
import "./engenharia/domain";

export {
  listDomains,
  getDomain,
  registerDomain,
  type DomainDefinition,
} from "./domain-registry";
