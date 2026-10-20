import { Prisma, type MessStaff } from "@prisma/client";
import { audit } from "../../lib/audit.js";
import { prisma } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import type { StaffInput, UpdateStaffInput } from "./staff.schema.js";

/** Phone numbers are for managers; members see who works for the mess and their role. */
const toStaffDto = (s: MessStaff, showPhone: boolean) => ({
  id: s.id,
  name: s.name,
  phone: showPhone ? s.phone : null,
  role: s.role,
  monthlySalary: s.monthlySalary.toFixed(2),
  isActive: s.isActive,
  joinedAt: s.joinedAt,
});

async function findStaff(messId: string, staffId: string) {
  const staff = await prisma.messStaff.findFirst({ where: { id: staffId, messId } });
  if (!staff) throw ApiError.notFound("Staff member not found");
  return staff;
}

/** Staff, with which of them have been paid in the given month (managers use it to pay salaries). */
export async function listStaff(membership: Membership, monthId?: string) {
  const showPhone = hasManagerAccess(membership);
  const [staff, payments] = await Promise.all([
    prisma.messStaff.findMany({
      where: { messId: membership.messId },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    monthId
      ? prisma.sharedExpense.findMany({
          where: { messId: membership.messId, monthId, staffId: { not: null } },
          select: { staffId: true, amount: true },
        })
      : Promise.resolve([]),
  ]);
  return staff.map((s) => {
    const paid = payments.filter((p) => p.staffId === s.id);
    return {
      ...toStaffDto(s, showPhone),
      paidThisMonth: paid.length > 0,
      paidAmount: paid.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0)).toFixed(2),
    };
  });
}

export async function createStaff(membership: Membership, input: StaffInput) {
  const staff = await prisma.messStaff.create({
    data: {
      messId: membership.messId,
      name: input.name,
      phone: input.phone ?? null,
      role: input.role,
      monthlySalary: new Prisma.Decimal(input.monthlySalary),
    },
  });
  await audit(prisma, {
    messId: membership.messId,
    actorId: membership.userId,
    action: "STAFF_ADDED",
    entity: "MessStaff",
    entityId: staff.id,
    after: { name: staff.name, role: staff.role, monthlySalary: staff.monthlySalary.toFixed(2) },
  });
  return toStaffDto(staff, true);
}

export async function updateStaff(membership: Membership, staffId: string, input: UpdateStaffInput) {
  const before = await findStaff(membership.messId, staffId);
  const staff = await prisma.messStaff.update({
    where: { id: before.id },
    data: {
      ...(input.name && { name: input.name }),
      ...(input.phone !== undefined && { phone: input.phone }),
      ...(input.role && { role: input.role }),
      ...(input.monthlySalary && { monthlySalary: new Prisma.Decimal(input.monthlySalary) }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
  await audit(prisma, {
    messId: membership.messId,
    actorId: membership.userId,
    action: "STAFF_UPDATED",
    entity: "MessStaff",
    entityId: staff.id,
    before: { monthlySalary: before.monthlySalary.toFixed(2), isActive: before.isActive },
    after: { monthlySalary: staff.monthlySalary.toFixed(2), isActive: staff.isActive },
  });
  return toStaffDto(staff, true);
}

/** Someone who was ever paid is kept (inactive) so past salary expenses keep their name. */
export async function deleteStaff(membership: Membership, staffId: string) {
  const staff = await findStaff(membership.messId, staffId);
  const paid = await prisma.sharedExpense.count({ where: { staffId: staff.id } });
  if (paid > 0) {
    await prisma.messStaff.update({ where: { id: staff.id }, data: { isActive: false } });
  } else {
    await prisma.messStaff.delete({ where: { id: staff.id } });
  }
  await audit(prisma, {
    messId: membership.messId,
    actorId: membership.userId,
    action: paid > 0 ? "STAFF_DEACTIVATED" : "STAFF_REMOVED",
    entity: "MessStaff",
    entityId: staff.id,
    before: { name: staff.name },
  });
  return { deactivated: paid > 0 };
}
