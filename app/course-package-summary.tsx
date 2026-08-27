import type {
  CoursePackageCatalogEntry,
  CoursePackageCatalogPurchase,
} from "@/lib/course-package-catalog";

export type CoursePackageSummaryProps = Readonly<{
  course: CoursePackageCatalogEntry;
  onOpenStudentPackage?: (studentId: string) => void;
  packagePreviewLimit?: number;
  purchasePreviewLimit?: number;
}>;

export const MAX_COURSE_PACKAGE_PREVIEW = 20;
export const MAX_COURSE_PURCHASE_PREVIEW = 8;

const hourFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });

function hours(value: number) {
  return hourFormatter.format(value);
}

function purchaseBreakdown(purchase: CoursePackageCatalogPurchase) {
  if (purchase.purchasedHours === undefined || purchase.bonusHours === undefined) {
    return `共 ${hours(purchase.hours)} 课时`;
  }
  return `购买 ${hours(purchase.purchasedHours)} + 赠送 ${hours(purchase.bonusHours)}`;
}

function previewLimit(value: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
}

/**
 * Read-only course/package projection. Mutations remain in the existing
 * student package workflow; the optional callback only navigates to it.
 */
export function CoursePackageSummary({
  course,
  onOpenStudentPackage,
  packagePreviewLimit = MAX_COURSE_PACKAGE_PREVIEW,
  purchasePreviewLimit = MAX_COURSE_PURCHASE_PREVIEW,
}: CoursePackageSummaryProps) {
  const visiblePackages = course.packages.slice(0, previewLimit(packagePreviewLimit, MAX_COURSE_PACKAGE_PREVIEW));
  const hiddenPackageCount = course.packages.length - visiblePackages.length;
  const visiblePurchases = course.purchases.slice(0, previewLimit(purchasePreviewLimit, MAX_COURSE_PURCHASE_PREVIEW));
  const hiddenPurchaseCount = course.purchases.length - visiblePurchases.length;
  const hasCoverage = Object.values(course.coverage).some((count) => count > 0);
  const hasPackageDetails = course.packageCount > 0 || hiddenPackageCount > 0 || course.invalidPackageCount > 0;
  const hasPurchaseSummary = course.purchaseRecordCount > 0
    || course.purchasedHours > 0
    || course.bonusHours > 0
    || course.unclassifiedHours > 0;
  const hasBookingSummary = course.bookingCount > 0 || course.eligibleTeacherCount !== null;

  return <>
    {course.packageCount > 0 || course.linkedStudentCount > 0 ? <div className="detail-section split" aria-label="课包汇总">
      {course.packageCount > 0 ? <div><span>课包</span><strong>{course.packageCount} 个</strong></div> : null}
      {course.linkedStudentCount > 0 ? <div><span>关联学生</span><strong>{course.linkedStudentCount} 人</strong></div> : null}
    </div> : null}
    {course.packageCount > 0 ? <div className="detail-section split">
      <div><span>总课时 / 已消耗</span><strong>{hours(course.totalHours)} / {hours(course.consumedHours)}</strong></div>
      <div><span>剩余课时</span><strong>{hours(course.remainingHours)}</strong></div>
    </div> : null}
    {hasPurchaseSummary ? <div className="detail-section">
      <span>购买与赠送</span>
      <strong>购买 {hours(course.purchasedHours)} · 赠送 {hours(course.bonusHours)}</strong>
      {course.unclassifiedHours > 0 ? <small>未拆分 {hours(course.unclassifiedHours)} 课时</small> : null}
    </div> : null}
    {hasCoverage ? <div className="detail-section">
      <span>课包覆盖</span>
      <strong>完整 {course.coverage.complete} · 部分 {course.coverage.partial} · 未绑定 {course.coverage.none}</strong>
    </div> : null}
    {hasBookingSummary ? <div className={`detail-section${course.eligibleTeacherCount === null || course.bookingCount === 0 ? "" : " split"}`}>
      {course.bookingCount > 0 ? <div><span>排课</span><strong>{course.bookingCount} 节</strong></div> : null}
      {course.eligibleTeacherCount === null ? null : <div><span>匹配老师</span><strong>{course.eligibleTeacherCount} 位</strong></div>}
    </div> : null}
    {course.eligibleTeachers?.length ? <div className="detail-section">
      <span>匹配老师</span>
      <p>{course.eligibleTeachers.map((teacher) => teacher.name).join("、")}</p>
    </div> : null}
    {hasPackageDetails ? <div className="detail-section">
      <span>课包明细</span>
      {visiblePackages.length ? <div className="timeline">
        {visiblePackages.map(({ viewKey, studentId, studentName, packageName, subjectIds, balance, sharedAcrossSubjects }) => <div className="timeline-item" data-course-package-row="true" key={viewKey}>
          <i className={balance && balance.remainingHours > 0 ? "green" : balance ? "amber" : "red"} aria-hidden="true" />
          <span>
            <strong>{studentName} · {packageName}</strong>
            <small>{balance
              ? `总 ${hours(balance.totalHours)} · 已消耗 ${hours(balance.consumedHours)} · 剩余 ${hours(balance.remainingHours)}`
              : "课包数据异常，未计入汇总"}</small>
            <small>{subjectIds.join(" / ")}{sharedAcrossSubjects ? " · 多科目共享课包" : ""}</small>
            {onOpenStudentPackage ? <button className="text-button" type="button" onClick={() => onOpenStudentPackage(studentId)}>查看学生课包</button> : null}
          </span>
        </div>)}
      </div> : null}
      {hiddenPackageCount > 0 ? <p>另有 {hiddenPackageCount} 个课包</p> : null}
      {course.invalidPackageCount ? <p>{course.invalidPackageCount} 个异常课包未计入汇总</p> : null}
    </div> : null}
    {course.studentsWithoutPackage.length ? <div className="detail-section">
      <span>未绑定课包</span>
      <p>{course.studentsWithoutPackage.map((student) => student.name).join("、")}</p>
    </div> : null}
    {course.purchaseRecordCount > 0 ? <div className="detail-section">
      <span>购买记录</span>
      {visiblePurchases.length ? <div className="timeline">
        {visiblePurchases.map((purchase) => <div className="timeline-item" data-course-purchase-row="true" key={purchase.viewKey}>
          <i className="blue" aria-hidden="true" />
          <span>
            <strong>+{hours(purchase.hours)} 课时 · {purchase.studentName}</strong>
            <small>{purchase.purchasedAt} · {purchaseBreakdown(purchase)}</small>
          </span>
        </div>)}
      </div> : null}
      {hiddenPurchaseCount > 0 ? <p>另有 {hiddenPurchaseCount} 条记录</p> : null}
    </div> : null}
  </>;
}
