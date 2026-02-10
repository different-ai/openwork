package com.winning.spark

import org.apache.spark.sql.{SparkSession, DataFrame}
import org.scalatest.{BeforeAndAfterAll, FunSuite}
import org.apache.spark.sql.functions._
import com.winning.spark.config.{ProcessorConfig, ValidationConfig, ValidationRule}
import com.winning.spark.processor.DataValidator

class DataValidatorTest extends FunSuite with BeforeAndAfterAll {
  private var spark: SparkSession = _
  
  override def beforeAll(): Unit = {
    spark = SparkSession.builder()
      .appName("DataValidatorTest")
      .master("local[2]")
      .getOrCreate()
  }
  
  override def afterAll(): Unit = {
    if (spark != null) {
      spark.stop()
    }
  }
  
  test("should filter records with null values when required") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三", 25),
      (null, "李四", 30),
      ("P003", "王五", 35)
    ).toDF("patient_id", "name", "age")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(
        enabled = true,
        rules = List(ValidationRule("patient_id", required = true))
      )
    )
    
    val validator = new DataValidator()
    val result = validator.process(data, config)
    
    assert(result.count() == 2)
    assert(result.filter(col("patient_id").isNull).count() == 0)
  }
  
  test("should validate field pattern") {
    import spark.implicits._
    
    val data = Seq(
      ("P0000001", "张三"),
      ("INVALID", "李四"),
      ("P1234567", "王五")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(
        enabled = true,
        rules = List(ValidationRule("patient_id", pattern = Some("^P[0-9]{7}$")))
      )
    )
    
    val validator = new DataValidator()
    val result = validator.process(data, config)
    
    assert(result.count() == 2)
  }
  
  test("should validate numeric range") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", 25),
      ("P002", -5),
      ("P003", 200),
      ("P004", 80)
    ).toDF("patient_id", "age")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(
        enabled = true,
        rules = List(ValidationRule("age", min = Some(0), max = Some(150)))
      )
    )
    
    val validator = new DataValidator()
    val result = validator.process(data, config)
    
    assert(result.count() == 2)
    assert(result.filter(col("patient_id") === "P001").count() == 1)
    assert(result.filter(col("patient_id") === "P004").count() == 1)
  }
  
  test("should pass through when validation is disabled") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三"),
      (null, "李四")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(enabled = false)
    )
    
    val validator = new DataValidator()
    val result = validator.process(data, config)
    
    assert(result.count() == 2)
  }
}
