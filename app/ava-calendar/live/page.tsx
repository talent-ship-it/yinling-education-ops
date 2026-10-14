import AuthClient from "../../auth-client";
import AvaCalendarLiveClient from "./calendar-client";
import styles from "./calendar.module.css";

export const dynamic = "force-dynamic";

export default function Page() {
  return <div className={styles.entry}><AuthClient authenticatedContent={<AvaCalendarLiveClient />} /></div>;
}
