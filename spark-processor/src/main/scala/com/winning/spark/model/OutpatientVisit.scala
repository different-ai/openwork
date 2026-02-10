package com.winning.spark.model

import java.sql.Timestamp

case class OutpatientVisit(
  visitId: String,
  patientId: String,
  patientName: String,
  gender: String,
  age: Int,
  department: String,
  doctorId: String,
  visitTime: Timestamp,
  diagnosisCode: String,
  diagnosisName: String,
  totalAmount: BigDecimal,
  paymentMethod: String,
  status: String,
  createTime: Timestamp
)
