import { DASHBOARD_PAGE_CLASS } from "../../../_components/ui/dashboard-styles";
import { ComputersInventoryRoute } from "../../_features/computers/inventory-admin-route";

export default function ComputersPage() {
  return <div className={DASHBOARD_PAGE_CLASS}><ComputersInventoryRoute /></div>;
}
