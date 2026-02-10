package com.winning.spark.model

import java.sql.Timestamp

case class Prescription(
  prescriptionId: String,
  visitId: String,
  patientId: String,
  drugCode: String,
  drugName: String,
  quantity: Int,
  unitPrice: BigDecimal,
  totalPrice: BigDecimal,
  dosage: String,
  prescriptionTime: Timestamp
)
