package com.winning.spark

import org.apache.spark.sql.SparkSession
import org.scalatest.{BeforeAndAfterAll, FunSuite}
import org.apache.spark.sql.functions._
import com.winning.spark.config.{ProcessorConfig, CleaningConfig}
import com.winning.spark.processor.DataCleaner

class DataCleanerTest extends FunSuite with BeforeAndAfterAll {
  private var spark: SparkSession = _
  
  override def beforeAll(): Unit = {
    spark = SparkSession.builder()
      .appName("DataCleanerTest")
      .master("local[2]")
      .getOrCreate()
  }
  
  override def afterAll(): Unit = {
    if (spark != null) {
      spark.stop()
    }
  }
  
  test("should trim whitespace from string columns") {
    import spark.implicits._
    
    val data = Seq(
      ("  P001  ", " 张三 "),
      ("P002", "李四")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      cleaning = CleaningConfig(enabled = true, trimWhitespace = true, removeDuplicates = false)
    )
    
    val cleaner = new DataCleaner()
    val result = cleaner.process(data, config)
    
    val rows = result.collect()
    assert(rows(0).getString(0) == "P001")
    assert(rows(0).getString(1) == "张三")
    assert(rows(1).getString(0) == "P002")
    assert(rows(1).getString(1) == "李四")
  }
  
  test("should remove duplicate records") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三"),
      ("P001", "张三"),
      ("P002", "李四")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      cleaning = CleaningConfig(enabled = true, trimWhitespace = false, removeDuplicates = true)
    )
    
    val cleaner = new DataCleaner()
    val result = cleaner.process(data, config)
    
    assert(result.count() == 2)
  }
  
  test("should not trim when disabled") {
    import spark.implicits._
    
    val data = Seq(
      ("  P001  ", " 张三 ")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      cleaning = CleaningConfig(enabled = true, trimWhitespace = false, removeDuplicates = false)
    )
    
    val cleaner = new DataCleaner()
    val result = cleaner.process(data, config)
    
    val rows = result.collect()
    assert(rows(0).getString(0) == "  P001  ")
    assert(rows(0).getString(1) == " 张三 ")
  }
  
  test("should pass through when cleaning is disabled") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三"),
      ("P001", "张三")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      cleaning = CleaningConfig(enabled = false)
    )
    
    val cleaner = new DataCleaner()
    val result = cleaner.process(data, config)
    
    assert(result.count() == 2)
  }
}
